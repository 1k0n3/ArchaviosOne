// Minimaler Leser für Unity-AssetBundles (UnityFS) mit Texture2D-Extraktion.
// Unterstützt LZ4/LZ4HC-Blöcke, SerializedFile ab Version 17, Texture2D per Typbaum
// (falls vorhanden) oder festem Layout. Dekodiert DXT1/DXT5/BC7/RGBA32/RGB24/ARGB32/RGBA4444/ETC2 nicht.
const fs = require("fs");
const zlib = require("zlib");

// ---- LZ4 Block-Dekompression ---------------------------------------------------------------
function lz4Decompress(src, dstSize) {
  const dst = Buffer.alloc(dstSize);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    src.copy(dst, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let mlen = (token & 15) + 4;
    if ((token & 15) === 15) { let b; do { b = src[s++]; mlen += b; } while (b === 255); }
    let ref = d - off;
    for (let k = 0; k < mlen; k++) dst[d++] = dst[ref++];
  }
  return dst;
}

// ---- Binärleser ---------------------------------------------------------------------------------
class R {
  constructor(buf, be = true) { this.b = buf; this.p = 0; this.be = be; }
  u8() { return this.b[this.p++]; }
  bool() { return this.u8() !== 0; }
  i16() { const v = this.be ? this.b.readInt16BE(this.p) : this.b.readInt16LE(this.p); this.p += 2; return v; }
  u16() { const v = this.be ? this.b.readUInt16BE(this.p) : this.b.readUInt16LE(this.p); this.p += 2; return v; }
  i32() { const v = this.be ? this.b.readInt32BE(this.p) : this.b.readInt32LE(this.p); this.p += 4; return v; }
  u32() { const v = this.be ? this.b.readUInt32BE(this.p) : this.b.readUInt32LE(this.p); this.p += 4; return v; }
  i64() { const v = this.be ? this.b.readBigInt64BE(this.p) : this.b.readBigInt64LE(this.p); this.p += 8; return Number(v); }
  u64() { const v = this.be ? this.b.readBigUInt64BE(this.p) : this.b.readBigUInt64LE(this.p); this.p += 8; return Number(v); }
  f32() { const v = this.be ? this.b.readFloatBE(this.p) : this.b.readFloatLE(this.p); this.p += 4; return v; }
  cstr() { const e = this.b.indexOf(0, this.p); const s = this.b.toString("utf8", this.p, e); this.p = e + 1; return s; }
  bytes(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  align(n = 4) { this.p = (this.p + n - 1) & ~(n - 1); }
  alignedStr() { const n = this.i32(); const s = this.b.toString("utf8", this.p, this.p + n); this.p += n; this.align(4); return s; }
}

// ---- UnityFS-Container ---------------------------------------------------------------------------
function readBundle(file) {
  const buf = fs.readFileSync(file);
  const r = new R(buf, true);
  const sig = r.cstr();
  if (sig !== "UnityFS") throw new Error("Kein UnityFS: " + sig);
  const version = r.u32();
  r.cstr(); r.cstr(); // unity version, revision
  const size = r.i64();
  const cInfo = r.u32(), uInfo = r.u32(), flags = r.u32();
  if (version >= 7) r.align(16);
  let infoBuf;
  if (flags & 0x80) { // blocks info at end
    infoBuf = buf.subarray(buf.length - cInfo, buf.length);
  } else {
    infoBuf = r.bytes(cInfo);
  }
  const comp = flags & 0x3f;
  let info;
  if (comp === 0) info = infoBuf;
  else if (comp === 2 || comp === 3) info = lz4Decompress(infoBuf, uInfo);
  else throw new Error("Blockinfo-Kompression nicht unterstützt: " + comp);
  const ir = new R(info, true);
  ir.bytes(16); // hash
  const nBlocks = ir.i32();
  const blocks = [];
  for (let i = 0; i < nBlocks; i++) blocks.push({ u: ir.u32(), c: ir.u32(), f: ir.u16() });
  const nNodes = ir.i32();
  const nodes = [];
  for (let i = 0; i < nNodes; i++) nodes.push({ off: ir.i64(), size: ir.i64(), flags: ir.u32(), path: ir.cstr() });
  if (flags & 0x200) r.align(16);
  // Datenblöcke
  const chunks = [];
  for (const b of blocks) {
    const c = r.bytes(b.c);
    const bc = b.f & 0x3f;
    if (bc === 0) chunks.push(c);
    else if (bc === 2 || bc === 3) chunks.push(lz4Decompress(c, b.u));
    else throw new Error("Block-Kompression nicht unterstützt: " + bc);
  }
  const data = Buffer.concat(chunks);
  return { version, flags, nodes, data, files: nodes.map((n) => ({ path: n.path, buf: data.subarray(n.off, n.off + n.size) })) };
}

// ---- SerializedFile -------------------------------------------------------------------------------------
function readTypeTree(r, version) {
  // Blob-Format (version >= 12)
  const nNodes = r.i32();
  const strSize = r.i32();
  const nodes = [];
  const nodeSize = version >= 19 ? 32 : 24;
  const start = r.p;
  for (let i = 0; i < nNodes; i++) {
    const nr = new R(r.b.subarray(start + i * nodeSize, start + (i + 1) * nodeSize), false);
    const n = { version: nr.u16(), level: nr.u8(), typeFlags: nr.u8(), typeStrOff: nr.u32(), nameStrOff: nr.u32(), size: nr.i32(), index: nr.u32(), metaFlag: nr.u32() };
    if (version >= 19) n.refHash = nr.u64();
    nodes.push(n);
  }
  r.p = start + nNodes * nodeSize;
  const strs = r.bytes(strSize);
  const getStr = (off) => {
    if (off & 0x80000000) return COMMON[off & 0x7fffffff] || ("?" + (off & 0x7fffffff));
    const e = strs.indexOf(0, off);
    return strs.toString("utf8", off, e);
  };
  for (const n of nodes) { n.type = getStr(n.typeStrOff); n.name = getStr(n.nameStrOff); }
  return nodes;
}
// Offizielle Unity-Tabelle (AssetStudio CommonString)
const COMMON = {
  0: "AABB",
  5: "AnimationClip",
  19: "AnimationCurve",
  34: "AnimationState",
  49: "Array",
  55: "Base",
  60: "BitField",
  69: "bitset",
  76: "bool",
  81: "char",
  86: "ColorRGBA",
  96: "Component",
  106: "data",
  111: "deque",
  117: "double",
  124: "dynamic_array",
  138: "FastPropertyName",
  155: "first",
  161: "float",
  167: "Font",
  172: "GameObject",
  183: "Generic Mono",
  196: "GradientNEW",
  208: "GUID",
  213: "GUIStyle",
  222: "int",
  226: "list",
  231: "long long",
  241: "map",
  245: "Matrix4x4f",
  256: "MdFour",
  263: "MonoBehaviour",
  277: "MonoScript",
  288: "m_ByteSize",
  299: "m_Curve",
  307: "m_EditorClassIdentifier",
  331: "m_EditorHideFlags",
  349: "m_Enabled",
  359: "m_ExtensionPtr",
  374: "m_GameObject",
  387: "m_Index",
  395: "m_IsArray",
  405: "m_IsStatic",
  416: "m_MetaFlag",
  427: "m_Name",
  434: "m_ObjectHideFlags",
  452: "m_PrefabInternal",
  469: "m_PrefabParentObject",
  490: "m_Script",
  499: "m_StaticEditorFlags",
  519: "m_Type",
  526: "m_Version",
  536: "Object",
  543: "pair",
  548: "PPtr<Component>",
  564: "PPtr<GameObject>",
  581: "PPtr<Material>",
  596: "PPtr<MonoBehaviour>",
  616: "PPtr<MonoScript>",
  633: "PPtr<Object>",
  646: "PPtr<Prefab>",
  659: "PPtr<Sprite>",
  672: "PPtr<TextAsset>",
  688: "PPtr<Texture>",
  702: "PPtr<Texture2D>",
  718: "PPtr<Transform>",
  734: "Prefab",
  741: "Quaternionf",
  753: "Rectf",
  759: "RectInt",
  767: "RectOffset",
  778: "second",
  785: "set",
  789: "short",
  795: "size",
  800: "SInt16",
  807: "SInt32",
  814: "SInt64",
  821: "SInt8",
  827: "staticvector",
  840: "string",
  847: "TextAsset",
  857: "TextMesh",
  866: "Texture",
  874: "Texture2D",
  884: "Transform",
  894: "TypelessData",
  907: "UInt16",
  914: "UInt32",
  921: "UInt64",
  928: "UInt8",
  934: "unsigned int",
  947: "unsigned long long",
  966: "unsigned short",
  981: "vector",
  988: "Vector2f",
  997: "Vector3f",
  1006: "Vector4f",
  1015: "m_ScriptingClassIdentifier",
  1042: "Gradient",
  1051: "Type*",
  1057: "int2_storage",
  1070: "int3_storage",
  1083: "BoundsInt",
  1093: "m_CorrespondingSourceObject",
  1121: "m_PrefabInstance",
  1138: "m_PrefabAsset",
  1152: "FileSize",
  1161: "Hash128",
  1169: "RenderingLayerMask"
};

function readSerialized(buf) {
  const r = new R(buf, true);
  let metaSize = r.u32(), fileSize = r.u32(), version = r.u32(), dataOff = r.u32();
  let be = true;
  if (version >= 9) { be = r.u8() !== 0; r.bytes(3); }
  if (version >= 22) { metaSize = r.u32(); fileSize = r.i64(); dataOff = r.i64(); r.i64(); }
  r.be = be;
  const unityVersion = version >= 7 ? r.cstr() : "";
  const platform = version >= 8 ? r.i32() : 0;
  const hasTree = version >= 13 ? r.bool() : true;
  const nTypes = r.i32();
  const types = [];
  for (let i = 0; i < nTypes; i++) {
    const t = { classId: r.i32() };
    if (version >= 16) t.isStripped = r.bool();
    if (version >= 17) t.scriptIndex = r.i16();
    if (version >= 13) {
      if ((version < 16 && t.classId < 0) || (version >= 16 && t.classId === 114)) t.scriptId = r.bytes(16);
      t.oldHash = r.bytes(16);
    }
    if (hasTree) {
      t.tree = readTypeTree(r, version);
      if (version >= 21) { const n = r.i32(); t.deps = []; for (let k = 0; k < n; k++) t.deps.push(r.i32()); }
    }
    types.push(t);
  }
  const nObj = r.i32();
  const objects = [];
  for (let i = 0; i < nObj; i++) {
    if (version >= 14) r.align(4);
    const o = { pathId: version >= 14 ? r.i64() : r.i32() };
    o.start = version >= 22 ? r.i64() : r.u32();
    o.size = r.u32();
    o.typeIndex = r.i32();
    if (version < 16) o.classId = r.u16(); else o.classId = types[o.typeIndex] ? types[o.typeIndex].classId : -1;
    if (version < 11) r.u16();
    if (version >= 11 && version < 17) r.i16();
    if (version === 15 || version === 16) r.u8();
    o.start += dataOff;
    objects.push(o);
  }
  return { version, unityVersion, be, hasTree, types, objects, buf };
}

// ---- Texture2D lesen -----------------------------------------------------------------------------
function readByTree(r, tree) {
  // Liest ein Objekt nach Typbaum in ein verschachteltes Objekt (nur was wir brauchen)
  let i = 0;
  function node() {
    const n = tree[i++];
    const val = value(n);
    return val;
  }
  function value(n) {
    const align = (n.metaFlag & 0x4000) !== 0;
    let v;
    const children = [];
    while (i < tree.length && tree[i].level > n.level) children.push(tree[i++]);
    // Kinder-Teilbaum separat verarbeiten
    if (n.type === "string") {
      const len = r.i32(); v = r.b.toString("utf8", r.p, r.p + len); r.p += len;
      if (align || true) r.align(4);
      return v;
    }
    const typeless = children.length >= 2 && children[0].name === "size" && children[1].name === "data";
    if (typeless || (children.length && children[0].type === "Array")) {
      // Array: children[0] = Array {size, data} bzw. TypelessData {size, data}
      const arr = typeless ? { level: n.level } : children[0];
      const sub = typeless ? children : children.slice(1); // size, data (+ data-Unterbaum)
      const dataNode = sub.find((c) => c.name === "data" && c.level === arr.level + 1);
      const dataSub = sub.slice(sub.indexOf(dataNode));
      const count = r.i32();
      if (dataNode.type === "UInt8" || dataNode.type === "char") { v = r.bytes(count); r.align(4); return v; }
      const out = [];
      const primitive = dataSub.length === 1;
      for (let k = 0; k < count; k++) { const el = readSub(dataSub); out.push(primitive ? el.data : el); }
      if (align) r.align(4);
      return out;
    }
    if (!children.length) {
      switch (n.type) {
        case "bool": v = r.bool(); break;
        case "SInt8": v = r.b.readInt8(r.p); r.p += 1; break;
        case "UInt8": case "char": v = r.u8(); break;
        case "SInt16": case "short": v = r.i16(); break;
        case "UInt16": case "unsigned short": v = r.u16(); break;
        case "int": case "SInt32": v = r.i32(); break;
        case "unsigned int": case "UInt32": case "Type*": v = r.u32(); break;
        case "SInt64": case "long long": v = r.i64(); break;
        case "UInt64": case "unsigned long long": case "FileSize": v = r.u64(); break;
        case "float": v = r.f32(); break;
        case "double": v = r.b.readDoubleBE(r.p); r.p += 8; break;
        default: throw new Error("Unbekannter Typ " + n.type + " (" + n.name + ")");
      }
      if (align) r.align(4);
      return v;
    }
    v = readSub(children);
    if (align) r.align(4);
    return v;
  }
  function readSub(sub) {
    const saveTree = tree, saveI = i;
    tree = sub; i = 0;
    const obj = {};
    while (i < tree.length) { const n = tree[i]; i++; const before = i; const val = value(n); obj[n.name] = val; }
    tree = saveTree; i = saveI;
    return obj;
  }
  const root = tree[0];
  i = 1;
  return value(root);
}

function readTexture(sf, obj, bundleFiles) {
  const t = sf.types[obj.typeIndex];
  const r = new R(sf.buf, sf.be);
  r.p = obj.start;
  let tex;
  if (t.tree) {
    tex = readByTree(r, t.tree);
  } else {
    throw new Error("Kein Typbaum im Bundle, festes Layout nicht implementiert");
  }
  let data = tex["image data"];
  if ((!data || !data.length) && tex.m_StreamData && tex.m_StreamData.size) {
    const sd = tex.m_StreamData;
    const p = sd.path.split("/").pop();
    const f = bundleFiles.find((x) => x.path === p || x.path.endsWith(p));
    if (f) data = f.buf.subarray(sd.offset, sd.offset + sd.size);
  }
  return { name: tex.m_Name, width: tex.m_Width, height: tex.m_Height, format: tex.m_TextureFormat, mipCount: tex.m_MipCount, data, raw: tex };
}

const FORMATS = { 1: "Alpha8", 2: "ARGB4444", 3: "RGB24", 4: "RGBA32", 5: "ARGB32", 7: "RGB565", 10: "DXT1", 12: "DXT5", 13: "RGBA4444", 14: "BGRA32", 25: "BC7", 26: "BC4", 27: "BC5", 34: "ETC_RGB4", 45: "ETC2_RGB", 47: "ETC2_RGBA8", 48: "ASTC_4x4", 49: "ASTC_5x5", 50: "ASTC_6x6", 51: "ASTC_8x8" };

// ---- Texturdekoder -> RGBA ---------------------------------------------------------------------
function decodeDXT(data, w, h, dxt5) {
  const out = Buffer.alloc(w * h * 4);
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
  let p = 0;
  const c = [[0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let alpha = null;
    if (dxt5) {
      const a0 = data[p], a1 = data[p + 1];
      const bits = Number(data.readBigUInt64LE(p) >> 16n);
      alpha = new Array(16);
      for (let k = 0; k < 16; k++) {
        const code = (bits / Math.pow(2, 3 * k)) & 7;
        let a;
        if (code === 0) a = a0; else if (code === 1) a = a1;
        else if (a0 > a1) a = ((8 - code) * a0 + (code - 1) * a1) / 7;
        else if (code === 6) a = 0; else if (code === 7) a = 255;
        else a = ((6 - code) * a0 + (code - 1) * a1) / 5;
        alpha[k] = a;
      }
      p += 8;
    }
    const c0 = data.readUInt16LE(p), c1 = data.readUInt16LE(p + 2);
    const idx = data.readUInt32LE(p + 4);
    p += 8;
    const rgb = (v) => [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
    const [r0, g0, b0] = rgb(c0), [r1, g1, b1] = rgb(c1);
    c[0] = [r0, g0, b0, 255]; c[1] = [r1, g1, b1, 255];
    if (c0 > c1 || dxt5) { c[2] = [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255]; c[3] = [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255]; }
    else { c[2] = [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255]; c[3] = [0, 0, 0, 0]; }
    for (let k = 0; k < 16; k++) {
      const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2);
      if (x >= w || y >= h) continue;
      const col = c[(idx >> (2 * k)) & 3];
      const o = (y * w + x) * 4;
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = alpha ? alpha[k] : col[3];
    }
  }
  return out;
}

function decodeRaw(data, w, h, fmt) {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (fmt === 4) { out[o] = data[o]; out[o + 1] = data[o + 1]; out[o + 2] = data[o + 2]; out[o + 3] = data[o + 3]; }
    else if (fmt === 3) { out[o] = data[i * 3]; out[o + 1] = data[i * 3 + 1]; out[o + 2] = data[i * 3 + 2]; out[o + 3] = 255; }
    else if (fmt === 5) { out[o] = data[o + 1]; out[o + 1] = data[o + 2]; out[o + 2] = data[o + 3]; out[o + 3] = data[o]; }
    else if (fmt === 14) { out[o] = data[o + 2]; out[o + 1] = data[o + 1]; out[o + 2] = data[o]; out[o + 3] = data[o + 3]; }
    else throw new Error("Rohformat nicht unterstützt: " + fmt);
  }
  return out;
}

// ---- PNG schreiben (Unity-Texturen sind vertikal gespiegelt) ------------------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function toPng(rgba, w, h, flip = true, alpha = true) {
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc((w * bpp + 1) * h);
  for (let y = 0; y < h; y++) {
    const sy = flip ? h - 1 - y : y;
    raw[y * (w * bpp + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const si = (sy * w + x) * 4, di = y * (w * bpp + 1) + 1 + x * bpp;
      raw[di] = rgba[si]; raw[di + 1] = rgba[si + 1]; raw[di + 2] = rgba[si + 2];
      if (alpha) raw[di + 3] = rgba[si + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

function extractTextures(file) {
  const b = readBundle(file);
  const out = [];
  for (const f of b.files) {
    if (!f.buf.length || f.path.endsWith(".resS") || f.path.endsWith(".resource")) continue;
    let sf;
    try { sf = readSerialized(f.buf); } catch (e) { continue; }
    for (const o of sf.objects) {
      if (o.classId !== 28) continue;
      try { out.push(Object.assign(readTexture(sf, o, b.files), { pathId: String(o.pathId) })); } catch (e) { out.push({ error: e.message }); }
    }
  }
  return out;
}

function textureToRgba(tex) {
  const fmt = tex.format;
  if (fmt === 10) return decodeDXT(tex.data, tex.width, tex.height, false);
  if (fmt === 12) return decodeDXT(tex.data, tex.width, tex.height, true);
  if (fmt === 25) return decodeBC7(tex.data, tex.width, tex.height);
  if ([3, 4, 5, 14].includes(fmt)) return decodeRaw(tex.data, tex.width, tex.height, fmt);
  throw new Error("Texturformat nicht unterstützt: " + (FORMATS[fmt] || fmt));
}

function textureToPng(tex) {
  const fmt = tex.format;
  let rgba;
  if (fmt === 10) rgba = decodeDXT(tex.data, tex.width, tex.height, false);
  else if (fmt === 12) rgba = decodeDXT(tex.data, tex.width, tex.height, true);
  else if (fmt === 25) rgba = decodeBC7(tex.data, tex.width, tex.height);
  else if ([3, 4, 5, 14].includes(fmt)) rgba = decodeRaw(tex.data, tex.width, tex.height, fmt);
  else throw new Error("Texturformat nicht unterstützt: " + (FORMATS[fmt] || fmt));
  return toPng(rgba, tex.width, tex.height, true, fmt === 12 || fmt === 25 || fmt === 4 || fmt === 5 || fmt === 14);
}

const { decodeBC7 } = require("./bc7");

/** Beliebiges Objekt über seinen Typbaum lesen (z. B. Sprite 213, SpriteAtlas 687078895) */
function readObject(sf, obj) {
  const t = sf.types[obj.typeIndex];
  if (!t || !t.tree) throw new Error("Kein Typbaum");
  const r = new R(sf.buf, sf.be); r.p = obj.start;
  return readByTree(r, t.tree);
}
/**
 * Sprites eines Bundles: Name, Rechteck in der Atlas-Textur (Unity-Koordinaten: y von unten) und Textur-PathID.
 * Bei gepackten Atlanten stehen die Rechtecke im SpriteAtlas (m_RenderDataMap), Reihenfolge wie m_PackedSprites.
 */
function extractSprites(file) {
  const b = readBundle(file);
  const out = [];
  for (const f of b.files) {
    if (!f.buf.length || f.path.endsWith(".resS") || f.path.endsWith(".resource")) continue;
    let sf; try { sf = readSerialized(f.buf); } catch (e) { continue; }
    // Arrays kommen aus dem Typbaum als [{data: …}]; Map-Einträge als {first: Schlüssel, second: Wert}
    const arr = (x) => (Array.isArray(x) ? x.map((e) => (e && e.data !== undefined ? e.data : e)) : []);
    const keyOf = (k) => k && k.first ? [0, 1, 2, 3].map((i) => k.first["data[" + i + "]"]).join(",") + ":" + k.second : "";
    const rdByKey = new Map();
    for (const o of sf.objects) {
      if (o.classId !== 687078895) continue;
      let a; try { a = readObject(sf, o); } catch (e) { continue; }
      for (const e of arr(a.m_RenderDataMap)) if (e && e.first && e.second) rdByKey.set(keyOf(e.first), e.second);
    }
    for (const o of sf.objects) {
      if (o.classId !== 213) continue;
      let s; try { s = readObject(sf, o); } catch (e) { continue; }
      const rd = rdByKey.get(keyOf(s.m_RenderDataKey)) || s.m_RD || {};
      const tr = rd.textureRect || s.m_Rect || {};
      out.push({ name: s.m_Name, texturePathId: rd.texture ? String(rd.texture.m_PathID) : null, x: tr.x, y: tr.y, width: tr.width, height: tr.height, rotated: ((rd.settingsRaw || 0) >> 2 & 0xF) !== 0, file: f.path });
    }
  }
  return out;
}

/**
 * Einzelnes Sprite eines Atlas-Bundles als PNG (RGBA). Unity-Rechtecke zählen y von unten, die dekodierten
 * Texturzeilen liegen ebenfalls von unten – der Ausschnitt wird zeilenweise kopiert und beim PNG-Schreiben gedreht.
 */
function spritePng(file, spriteName, opts = {}) {
  const sprites = extractSprites(file);
  const sp = sprites.find((s) => s.name === spriteName);
  if (!sp || !(sp.width > 0)) return null;
  const texs = extractTextures(file).filter((t) => !t.error);
  let tex = texs.find((t) => sp.texturePathId && String(t.pathId) === sp.texturePathId);
  if (!tex) tex = texs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!tex) return null;
  const rgba = textureToRgba(tex);
  const x = Math.max(0, Math.floor(sp.x)), y = Math.max(0, Math.floor(sp.y));
  const w = Math.min(tex.width - x, Math.ceil(sp.width)), h = Math.min(tex.height - y, Math.ceil(sp.height));
  const crop = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) rgba.copy(crop, row * w * 4, ((y + row) * tex.width + x) * 4, ((y + row) * tex.width + x + w) * 4);
  const scale = opts.maxHeight && h > opts.maxHeight ? opts.maxHeight / h : 1;
  if (scale === 1) return { png: toPng(crop, w, h, true, true), width: w, height: h };
  // Verkleinern (Mittelwert je Zielpixel), z. B. für Vorschaubilder in der Website-Synchronisierung
  const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
  const small = Buffer.alloc(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) for (let dx = 0; dx < dw; dx++) {
    const sx0 = Math.floor(dx / scale), sx1 = Math.min(w, Math.ceil((dx + 1) / scale)), sy0 = Math.floor(dy / scale), sy1 = Math.min(h, Math.ceil((dy + 1) / scale));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) { const i = (sy * w + sx) * 4; r += crop[i]; g += crop[i + 1]; b += crop[i + 2]; a += crop[i + 3]; n++; }
    const o = (dy * dw + dx) * 4; small[o] = r / n; small[o + 1] = g / n; small[o + 2] = b / n; small[o + 3] = a / n;
  }
  return { png: toPng(small, dw, dh, true, true), width: dw, height: dh };
}

module.exports = { readBundle, readSerialized, extractTextures, extractSprites, spritePng, readObject, textureToPng, textureToRgba, toPng, FORMATS, lz4Decompress };

if (require.main === module) {
  const file = process.argv[2];
  const b = readBundle(file);
  console.log("Bundle-Version", b.version, "Flags 0x" + b.flags.toString(16), "Dateien:", b.files.map((f) => f.path + " (" + f.buf.length + " B)").join(", "));
  for (const f of b.files) {
    if (f.path.endsWith(".resS")) continue;
    try {
      const sf = readSerialized(f.buf);
      console.log("SerializedFile v" + sf.version, sf.unityVersion, "BE:" + sf.be, "Typbaum:" + sf.hasTree, "Typen:", sf.types.map((t) => t.classId).join(","), "Objekte:", sf.objects.map((o) => o.classId + "@" + o.start + "+" + o.size).join(" "));
      for (const o of sf.objects) {
        if (o.classId !== 28) continue;
        const tex = readTexture(sf, o, b.files);
        console.log("Texture2D:", tex.name, tex.width + "x" + tex.height, "Format", FORMATS[tex.format] || tex.format, "Mips", tex.mipCount, "Daten", tex.data ? tex.data.length : 0, "Stream", JSON.stringify(tex.raw.m_StreamData));
        if (process.argv[3]) { fs.writeFileSync(process.argv[3], textureToPng(tex)); console.log("PNG geschrieben:", process.argv[3]); }
      }
    } catch (e) { console.log("Fehler:", e.message); }
  }
}
