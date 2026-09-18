<?php
// MTGA Stats Website – Einstellungen für Shared Hosting. Als config.php speichern und anpassen.
return [
  // Öffentliche Adresse (für Links in E-Mails und OAuth-Rückrufe), ohne Schrägstrich am Ende
  'base_url' => 'https://mtga.deine-domain.de',

  // Datenbank: SQLite (Standard, keine Einrichtung nötig) oder MySQL/MariaDB
  'db' => [
    'driver' => 'sqlite',                       // 'sqlite' oder 'mysql'
    'sqlite_file' => __DIR__ . '/data/mtga-stats.sqlite',
    'mysql' => ['host' => 'localhost', 'name' => 'mtga', 'user' => 'mtga', 'pass' => 'geheim', 'charset' => 'utf8mb4'],
  ],

  // Geheimnis für Cookie-/CSRF-Signaturen: leer = wird beim ersten Aufruf erzeugt und in data/ abgelegt
  'secret' => '',
  'session_days' => 30,

  // E-Mail: 'mail' nutzt die PHP-Funktion mail() des Hosters; 'smtp' einen SMTP-Server; 'log' schreibt Links nur ins Log (data/mail.log)
  'mail' => [
    'mode' => 'mail',
    'from' => 'MTGA Stats <no-reply@deine-domain.de>',
    'smtp' => ['host' => 'smtp.deine-domain.de', 'port' => 465, 'secure' => 'ssl', 'user' => '', 'pass' => ''],   // secure: 'ssl' | 'tls' | ''
  ],

  // OAuth (optional). Rückruf-Adressen: base_url/auth/discord/callback bzw. base_url/auth/google/callback
  'oauth' => [
    'discord' => ['id' => '', 'secret' => ''],
    'google' => ['id' => '', 'secret' => ''],
  ],

  // Neue Konten erlauben
  'registration_open' => true,
  // E-Mail-Bestätigung verlangen? false = Konto ist sofort nutzbar (praktisch, wenn der Hoster keine Mails verschickt)
  'verify_email' => true,

  // Companion-Download: GitHub-Repository (owner/name) → direkter ZIP-Link; download_url überschreibt ihn
  'github_repo' => '',
  'download_url' => '',

  // Kartendaten von Scryfall: cron.php?key=… oder "php cron.php" alle 5 Minuten aufrufen (lädt schrittweise ~20.000 Karten)
  'cron_key' => 'bitte-aendern',

  // Hinter einem Proxy die Client-IP aus X-Forwarded-For lesen
  'trust_proxy' => false,
];
