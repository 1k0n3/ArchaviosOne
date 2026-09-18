<?php
// E-Mail-Versand: mail() des Hosters, einfacher SMTP-Client oder nur Protokoll (data/mail.log) für die Entwicklung.
declare(strict_types=1);

function mail_send(string $to, string $subject, string $text): bool {
  $mode = cfg('mail.mode', 'mail');
  $from = (string)cfg('mail.from', 'MTGA Stats <no-reply@localhost>');
  if ($mode === 'log') { @file_put_contents(DATA_DIR . '/mail.log', "[" . now_iso() . "] an $to: $subject\n$text\n\n", FILE_APPEND); return false; }
  if ($mode === 'smtp') return smtp_send($from, $to, $subject, $text);
  $fromAddr = preg_match('/<([^>]+)>/', $from, $mm) ? $mm[1] : $from;
  $headers = "From: $from\r\nReply-To: $fromAddr\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\nX-Mailer: MTGA Stats";
  $subj = '=?UTF-8?B?' . base64_encode($subject) . '?=';
  // Umschlag-Absender (Return-Path) mitgeben: viele Hoster verwerfen Mails ohne passende Absenderdomain stillschweigend
  $ok = @mail($to, $subj, $text, $headers, '-f' . $fromAddr);
  if (!$ok) $ok = @mail($to, $subj, $text, $headers);
  if (!$ok) { $e = error_get_last(); app_log('mail() fehlgeschlagen: ' . ($e['message'] ?? 'unbekannt')); }
  return $ok;
}
function mail_verify(string $to, string $link): bool { return mail_send($to, 'MTGA Stats: E-Mail bestätigen', "Willkommen bei MTGA Stats!\n\nBitte bestätige deine E-Mail-Adresse über diesen Link (24 Stunden gültig):\n$link\n\nWenn du dich nicht registriert hast, ignoriere diese Mail."); }
function mail_reset(string $to, string $link): bool { return mail_send($to, 'MTGA Stats: Passwort zurücksetzen', "Über diesen Link kannst du ein neues Passwort setzen (2 Stunden gültig):\n$link\n\nWenn du das nicht angefordert hast, ignoriere diese Mail. Dein Passwort bleibt unverändert."); }

/** Minimaler SMTP-Client (AUTH LOGIN, SSL oder STARTTLS) */
function smtp_send(string $from, string $to, string $subject, string $text): bool {
  $c = cfg('mail.smtp', []);
  $host = $c['host'] ?? ''; $port = (int)($c['port'] ?? 587); $secure = $c['secure'] ?? 'tls';
  $fp = @stream_socket_client(($secure === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . $port, $errno, $errstr, 15);
  if (!$fp) { app_log("SMTP: $errstr"); return false; }
  $read = function () use ($fp) { $out = ''; while (($line = fgets($fp, 1024)) !== false) { $out .= $line; if (!isset($line[3]) || $line[3] !== '-') break; } return $out; };
  $cmd = function (string $s, string $ok) use ($fp, $read) { fwrite($fp, $s . "\r\n"); $r = $read(); if (!str_starts_with($r, $ok)) throw new RuntimeException("SMTP: $s -> " . trim($r)); return $r; };
  try {
    $read();
    $cmd('EHLO ' . (parse_url(cfg('base_url', 'http://localhost'), PHP_URL_HOST) ?: 'localhost'), '250');
    if ($secure === 'tls') { $cmd('STARTTLS', '220'); stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT); $cmd('EHLO localhost', '250'); }
    if (!empty($c['user'])) { $cmd('AUTH LOGIN', '334'); $cmd(base64_encode($c['user']), '334'); $cmd(base64_encode($c['pass'] ?? ''), '235'); }
    $fromAddr = preg_match('/<([^>]+)>/', $from, $m) ? $m[1] : $from;
    $cmd("MAIL FROM:<$fromAddr>", '250'); $cmd("RCPT TO:<$to>", '250'); $cmd('DATA', '354');
    $msg = "From: $from\r\nTo: $to\r\nSubject: =?UTF-8?B?" . base64_encode($subject) . "?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nDate: " . date(DATE_RFC2822) . "\r\n\r\n" . preg_replace('/^\./m', '..', $text);
    $cmd($msg . "\r\n.", '250'); $cmd('QUIT', '221');
    fclose($fp); return true;
  } catch (Throwable $e) { app_log($e->getMessage()); @fclose($fp); return false; }
}
