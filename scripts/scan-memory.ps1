<#
.SYNOPSIS
  Liest die Kartensammlung aus dem Arbeitsspeicher des laufenden MTGA-Clients.

.DESCRIPTION
  Durchsucht alle lesbaren Speicherbereiche von MTGA.exe nach Blöcken aus
  (GrpId, Anzahl)-Paaren. GrpIds werden gegen die Liste gültiger IDs aus der
  MTGA-Kartendatenbank geprüft (IdFile, eine ID pro Zeile). Gefundene Blöcke
  werden als JSON in OutFile geschrieben. Es wird ausschließlich gelesen.

.PARAMETER IdFile    Textdatei mit gültigen GrpIds (eine pro Zeile)
.PARAMETER OutFile   Ziel-JSON
.PARAMETER MaxQty    Höchste plausible Anzahl pro Karte (Standard 400)
.PARAMETER MinBlock  Mindestanzahl Paare, damit ein Block gemeldet wird (Standard 50)
.PARAMETER MaxGap    Erlaubte ungültige Paare in Folge innerhalb eines Blocks (Standard 64)
.PARAMETER IncludeMapped  Auch MEM_MAPPED-Bereiche durchsuchen (langsamer)
.PARAMETER ProcessId  PID von MTGA (Standard: automatisch)
.PARAMETER Address   Nur diesen Speicherbereich lesen (Schnellprüfung eines bekannten Blocks), dezimal
.PARAMETER Length    Länge des Bereichs in Bytes (nur mit Address)
#>
param(
  [Parameter(Mandatory = $true)][string]$IdFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$MaxQty = 400,
  [int]$MinBlock = 50,
  [int]$MaxGap = 64,
  [switch]$IncludeMapped,
  [int]$ProcessId = 0,
  [long]$Address = 0,
  [long]$Length = 0
)

$ErrorActionPreference = "Stop"

$src = @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MtgaScan
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);

    [StructLayout(LayoutKind.Sequential)]
    public struct MBI
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_VM_READ = 0x0010;
    const uint MEM_COMMIT = 0x1000;
    const uint MEM_PRIVATE = 0x20000;
    const uint MEM_MAPPED = 0x40000;
    const uint PAGE_NOACCESS = 0x01;
    const uint PAGE_GUARD = 0x100;

    public class Block
    {
        public long Address;
        public int Stride;
        public int Offset;
        public int Count;
        public int Dups;
        public int HashMatch;
        public List<int> Ids = new List<int>();
        public List<int> Qtys = new List<int>();
        public HashSet<int> Seen = new HashSet<int>();
    }

    public class Stats
    {
        public long Regions;
        public long BytesScanned;
        public long BytesSkipped;
        public int BlocksFound;
    }

    static bool Readable(uint protect)
    {
        if ((protect & PAGE_GUARD) != 0) return false;
        if ((protect & PAGE_NOACCESS) != 0) return false;
        return protect != 0;
    }

    public static Stats Run(int pid, bool[] valid, int maxQty, int minBlock, int maxGap, bool includeMapped, string outFile, long onlyAddr, long onlyLen)
    {
        var stats = new Stats();
        var blocks = new List<Block>();
        IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (h == IntPtr.Zero)
        {
            int err = Marshal.GetLastWin32Error();
            if (err == 5)
                throw new Exception("Zugriff auf MTGA verweigert (Win32-Fehler 5): MTGA läuft mit Administratorrechten, der Watcher nicht. Entweder MTGA ohne Administratorrechte starten oder die Autostart-Aufgabe erhöht einrichten (install-autostart.ps1 -Elevated in einer Administrator-PowerShell).");
            throw new Exception("OpenProcess fehlgeschlagen (Win32-Fehler " + err + "). Läuft MTGA? Gleicher Benutzer?");
        }

        try
        {
            long addr = 0;
            long maxAddr = 0x00007FFFFFFFFFFF;
            int mbiSize = Marshal.SizeOf(typeof(MBI));
            const int CHUNK = 64 * 1024 * 1024;
            byte[] buf = new byte[CHUNK];
            int[] ints = new int[CHUNK / 4];
            bool[] v = new bool[CHUNK / 4];
            bool[] q = new bool[CHUNK / 4];

            if (onlyLen > 0)
            {
                // Schnellprüfung: nur einen bekannten Bereich lesen
                long pos = 0;
                while (pos < onlyLen)
                {
                    int want = (int)Math.Min(CHUNK, onlyLen - pos);
                    IntPtr got;
                    if (!ReadProcessMemory(h, (IntPtr)(onlyAddr + pos), buf, (IntPtr)want, out got) || (long)got == 0)
                    {
                        stats.BytesSkipped += want;
                        break;
                    }
                    int n = (int)got / 4;
                    stats.BytesScanned += (long)got;
                    stats.Regions = 1;
                    Buffer.BlockCopy(buf, 0, ints, 0, n * 4);
                    ScanChunk(ints, n, onlyAddr + pos, valid, v, q, maxQty, minBlock, maxGap, blocks);
                    pos += (long)got;
                }
                maxAddr = 0; // Hauptschleife überspringen
            }

            while (addr < maxAddr)
            {
                MBI mbi;
                IntPtr r = VirtualQueryEx(h, (IntPtr)addr, out mbi, (IntPtr)mbiSize);
                if (r == IntPtr.Zero) break;
                long size = (long)mbi.RegionSize;
                long next = (long)mbi.BaseAddress + size;
                if (next <= addr) break;

                bool take = mbi.State == MEM_COMMIT && Readable(mbi.Protect) &&
                            (mbi.Type == MEM_PRIVATE || (includeMapped && mbi.Type == MEM_MAPPED));
                if (take)
                {
                    stats.Regions++;
                    long pos = 0;
                    while (pos < size)
                    {
                        int want = (int)Math.Min(CHUNK, size - pos);
                        IntPtr got;
                        if (!ReadProcessMemory(h, (IntPtr)((long)mbi.BaseAddress + pos), buf, (IntPtr)want, out got) || (long)got == 0)
                        {
                            stats.BytesSkipped += want;
                            break;
                        }
                        int n = (int)got / 4;
                        stats.BytesScanned += (long)got;
                        Buffer.BlockCopy(buf, 0, ints, 0, n * 4);
                        ScanChunk(ints, n, (long)mbi.BaseAddress + pos, valid, v, q, maxQty, minBlock, maxGap, blocks);
                        pos += (long)got;
                    }
                }
                else
                {
                    stats.BytesSkipped += size;
                }
                addr = next;
            }
        }
        finally
        {
            CloseHandle(h);
        }

        blocks.Sort((a, b) => b.Count.CompareTo(a.Count));
        stats.BlocksFound = blocks.Count;
        WriteJson(blocks, stats, outFile);
        return stats;
    }

    static void ScanChunk(int[] a, int n, long baseAddr, bool[] valid, bool[] v, bool[] q, int maxQty, int minBlock, int maxGap, List<Block> blocks)
    {
        int vlen = valid.Length;
        for (int i = 0; i < n; i++)
        {
            int x = a[i];
            v[i] = x > 0 && x < vlen && valid[x];
            q[i] = x >= 1 && x <= maxQty;
        }

        int[] strides = { 2, 3, 4 };
        foreach (int s in strides)
        {
            for (int o = 0; o < s; o++)
            {
                Block cur = null;
                int gap = 0;
                for (int i = o; i + 1 < n; i += s)
                {
                    if (v[i] && q[i + 1])
                    {
                        if (cur == null)
                        {
                            cur = new Block();
                            cur.Address = baseAddr + (long)i * 4;
                            cur.Stride = s;
                            cur.Offset = o;
                        }
                        int id = a[i];
                        if (cur.Seen.Contains(id)) cur.Dups++;
                        else
                        {
                            cur.Seen.Add(id);
                            cur.Ids.Add(id);
                            cur.Qtys.Add(a[i + 1]);
                        }
                        cur.Count++;
                        if (s == 4 && i >= 2 && a[i - 2] == id) cur.HashMatch++;
                        gap = 0;
                    }
                    else if (cur != null)
                    {
                        gap++;
                        if (gap > maxGap)
                        {
                            if (cur.Count >= minBlock) blocks.Add(cur);
                            cur = null;
                            gap = 0;
                        }
                    }
                }
                if (cur != null && cur.Count >= minBlock) blocks.Add(cur);
            }
        }
    }

    static void WriteJson(List<Block> blocks, Stats st, string outFile)
    {
        var sb = new StringBuilder();
        sb.Append("{\"stats\":{\"regions\":").Append(st.Regions)
          .Append(",\"bytesScanned\":").Append(st.BytesScanned)
          .Append(",\"bytesSkipped\":").Append(st.BytesSkipped)
          .Append(",\"blocks\":").Append(blocks.Count).Append("},\"blocks\":[");
        int limit = Math.Min(blocks.Count, 40);
        for (int b = 0; b < limit; b++)
        {
            var bl = blocks[b];
            if (b > 0) sb.Append(",");
            sb.Append("{\"address\":\"0x").Append(bl.Address.ToString("X"))
              .Append("\",\"stride\":").Append(bl.Stride)
              .Append(",\"offset\":").Append(bl.Offset)
              .Append(",\"count\":").Append(bl.Count)
              .Append(",\"unique\":").Append(bl.Ids.Count)
              .Append(",\"dups\":").Append(bl.Dups)
              .Append(",\"hashMatch\":").Append(bl.HashMatch)
              .Append(",\"entries\":[");
            for (int i = 0; i < bl.Ids.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append("[").Append(bl.Ids[i]).Append(",").Append(bl.Qtys[i]).Append("]");
            }
            sb.Append("]}");
        }
        sb.Append("]}");
        File.WriteAllText(outFile, sb.ToString(), new UTF8Encoding(false));
    }
}
"@

if (-not ([System.Management.Automation.PSTypeName]"MtgaScan").Type) {
  Add-Type -TypeDefinition $src -Language CSharp
}

if ($ProcessId -eq 0) {
  $p = Get-Process -Name MTGA -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { Write-Error "MTGA.exe läuft nicht. Bitte MTGA starten, einloggen und die Sammlung öffnen."; exit 2 }
  $ProcessId = $p.Id
}

$ids = Get-Content -LiteralPath $IdFile | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
$max = ($ids | Measure-Object -Maximum).Maximum
$valid = New-Object bool[] ($max + 1)
foreach ($id in $ids) { $valid[$id] = $true }

if ($Length -gt 0) {
  Write-Host ("Schnellpruefung MTGA (PID {0}) bei 0x{1:X}, {2:n0} KB ..." -f $ProcessId, $Address, ($Length / 1KB))
} else {
  Write-Host ("Scanne MTGA (PID {0}), {1} gueltige IDs, MaxQty {2} ..." -f $ProcessId, $ids.Count, $MaxQty)
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$st = [MtgaScan]::Run($ProcessId, $valid, $MaxQty, $MinBlock, $MaxGap, [bool]$IncludeMapped, $OutFile, $Address, $Length)
$sw.Stop()
Write-Host ("Fertig in {0:n1} s: {1} Regionen, {2:n0} MB gelesen, {3} Bloecke >= {4} Paare" -f $sw.Elapsed.TotalSeconds, $st.Regions, ($st.BytesScanned / 1MB), $st.BlocksFound, $MinBlock)
