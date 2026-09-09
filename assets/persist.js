/* ============================================================
   SLPPersist - Persistenz-Baustein für die Open-Space-Lernpfade
   Deutsch-Luxemburgisches Schengen-Lyzeum Perl
   ------------------------------------------------------------
   Was der Baustein macht:
   - speichert alle Eingabefelder automatisch im localStorage
   - stellt sie beim nächsten Oeffnen wieder her
   - exportiert den Stand als JSON-Datei oder als Text zum Kopieren
   - liest denselben Stand wieder ein (Wechsel auf ein anderes iPad)
   - setzt auf Rückfrage alles zurueck

   Wichtig für den Einsatz: localStorage ist nur eine
   Komfortfunktion. Safari löscht per ITP Daten von Seiten, die
   sieben Tage nicht besucht wurden. Die eigentliche Sicherung
   ist der Export. Der Baustein weist die Nutzer darauf hin.

   Keine Abhängigkeiten, kein Build-Schritt, kein Fremdhost.

   Einbindung:
     <link rel="stylesheet" href="assets/slp-tokens.css">
     <script src="assets/persist.js"></script>
     <script>
       SLPPersist.init({
         seite: 'projektidee',
         bereich: '.steps-card',
         ziel: '#sicherung',
         nachWiederherstellung: updateProgress,
         klartextQuelle: buildOnepagerHtml,
         dateiname: 'Projektidee'
       });
     </script>
   ============================================================ */

(function (global) {
  'use strict';

  var KEY_PRAEFIX = 'openspace:';
  var FORMAT_VERSION = 1;
  var SPEICHER_VERZOEGERUNG = 500;   // ms, Debounce

  var cfg = null;
  var speicherKey = '';
  var felder = [];                   // [{key, typ, elemente}]
  var speicherMoeglich = false;
  var speicherTimer = null;
  var statusEl = null;
  var meldungEl = null;
  var meldungTimer = null;
  var stilEingefuegt = false;

  /* ---------- kleine Helfer ---------- */

  function el(tag, klasse, text) {
    var e = document.createElement(tag);
    if (klasse) { e.className = klasse; }
    if (text !== undefined && text !== null) { e.textContent = text; }
    return e;
  }

  function uhrzeit(datum) {
    var h = String(datum.getHours()).padStart(2, '0');
    var m = String(datum.getMinutes()).padStart(2, '0');
    return h + ':' + m;
  }

  function heuteFuerDateiname() {
    var d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  /* Wandelt den Onepager-HTML in lesbaren Text um - für die
     Abgabe in DiLer, wo kein HTML eingefuegt werden kann. */
  function htmlZuText(html) {
    var behaelter = el('div');
    behaelter.innerHTML = String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h1|h2|h3|h4|tr|li)>/gi, '\n')
      .replace(/<\/td>/gi, '\t');
    var text = behaelter.textContent || '';
    return text
      .split('\n')
      .map(function (zeile) { return zeile.replace(/[ \t]+$/g, '').trim(); })
      .filter(function (zeile, i, alle) {
        // hoechstens eine Leerzeile am Stueck
        return zeile !== '' || (i > 0 && alle[i - 1] !== '');
      })
      .join('\n')
      .trim();
  }

  /* ---------- Feld-Erfassung ----------
     Der Schlüssel eines Feldes kommt aus id oder name - niemals
     aus der Position im DOM. Eine Indexierung über die
     Reihenfolge wuerde bei jedem Umbau der Seite still die
     falschen Werte zuordnen. Felder ohne id und ohne name werden
     deshalb bewusst übersprungen und gemeldet. */

  function felderErfassen() {
    var bereich = document.querySelector(cfg.bereich);
    if (!bereich) {
      console.warn('SLPPersist: Bereich "' + cfg.bereich + '" nicht gefunden.');
      return [];
    }

    var alle = bereich.querySelectorAll('input, textarea, select');
    var gefunden = [];
    var nachKey = {};
    var ohneKennung = 0;

    Array.prototype.forEach.call(alle, function (element) {
      if (element.type === 'file' || element.type === 'submit' ||
          element.type === 'button' || element.type === 'reset') { return; }
      if (element.closest('[data-slp-ignore]')) { return; }

      var istGruppe = (element.type === 'radio' || element.type === 'checkbox');
      var key = istGruppe ? (element.name || element.id) : (element.id || element.name);

      if (!key) { ohneKennung++; return; }

      if (nachKey[key]) {
        nachKey[key].elemente.push(element);
        return;
      }

      var eintrag = {
        key: key,
        typ: element.type === 'radio' ? 'radio'
           : element.type === 'checkbox' ? 'checkbox'
           : 'wert',
        elemente: [element]
      };
      nachKey[key] = eintrag;
      gefunden.push(eintrag);
    });

    if (ohneKennung > 0) {
      console.warn('SLPPersist: ' + ohneKennung + ' Feld(er) ohne id und ohne name ' +
                   'werden nicht gespeichert. Bitte stabile ids ergaenzen.');
    }
    return gefunden;
  }

  function werteLesen() {
    var daten = {};
    felder.forEach(function (feld) {
      if (feld.typ === 'radio') {
        var gewaehlt = feld.elemente.find(function (e) { return e.checked; });
        if (gewaehlt) { daten[feld.key] = gewaehlt.value; }
      } else if (feld.typ === 'checkbox') {
        if (feld.elemente.length === 1 && !feld.elemente[0].value) {
          // einzelne Ja/Nein-Box ohne eigenen Wert
          daten[feld.key] = feld.elemente[0].checked;
        } else {
          var werte = feld.elemente
            .filter(function (e) { return e.checked; })
            .map(function (e) { return e.value; });
          if (werte.length) { daten[feld.key] = werte; }
        }
      } else {
        var wert = feld.elemente[0].value;
        if (wert !== '') { daten[feld.key] = wert; }
      }
    });
    return daten;
  }

  function werteSetzen(daten) {
    felder.forEach(function (feld) {
      var wert = daten[feld.key];

      if (feld.typ === 'radio') {
        feld.elemente.forEach(function (e) { e.checked = (wert !== undefined && e.value === wert); });
      } else if (feld.typ === 'checkbox') {
        if (feld.elemente.length === 1 && !feld.elemente[0].value) {
          feld.elemente[0].checked = (wert === true);
        } else {
          var liste = Array.isArray(wert) ? wert : [];
          feld.elemente.forEach(function (e) { e.checked = liste.indexOf(e.value) !== -1; });
        }
      } else {
        feld.elemente[0].value = (wert === undefined || wert === null) ? '' : wert;
      }
    });
  }

  /* ---------- Speicher ---------- */

  function speicherPruefen() {
    try {
      var test = '__slp_test__';
      global.localStorage.setItem(test, '1');
      global.localStorage.removeItem(test);
      return true;
    } catch (fehler) {
      return false;
    }
  }

  function speichern() {
    if (!speicherMoeglich) { return false; }
    var paket = {
      v: FORMAT_VERSION,
      seite: cfg.seite,
      gespeichert: new Date().toISOString(),
      felder: werteLesen()
    };
    try {
      global.localStorage.setItem(speicherKey, JSON.stringify(paket));
      statusSetzen('gespeichert', new Date(paket.gespeichert));
      return true;
    } catch (fehler) {
      speicherMoeglich = false;
      statusSetzen('fehler');
      console.warn('SLPPersist: Speichern nicht moeglich.', fehler);
      return false;
    }
  }

  function speichernVerzoegert() {
    if (speicherTimer) { clearTimeout(speicherTimer); }
    speicherTimer = setTimeout(function () {
      speicherTimer = null;
      speichern();
    }, SPEICHER_VERZOEGERUNG);
  }

  function geladenesPaket() {
    if (!speicherMoeglich) { return null; }
    try {
      var roh = global.localStorage.getItem(speicherKey);
      if (!roh) { return null; }
      var paket = JSON.parse(roh);
      if (!paket || typeof paket !== 'object' || !paket.felder) { return null; }
      return paket;
    } catch (fehler) {
      console.warn('SLPPersist: Gespeicherter Stand ist unlesbar.', fehler);
      return null;
    }
  }

  function wiederherstellen() {
    var paket = geladenesPaket();
    if (!paket) {
      statusSetzen(speicherMoeglich ? 'leer' : 'fehler');
      return false;
    }
    werteSetzen(paket.felder);
    statusSetzen('gespeichert', new Date(paket.gespeichert));
    return true;
  }

  /* ---------- Statusanzeige ---------- */

  function statusSetzen(zustand, zeitpunkt) {
    if (!statusEl) { return; }
    statusEl.classList.remove('slp-status--warn');

    if (zustand === 'gespeichert' && zeitpunkt) {
      statusEl.textContent = 'Zuletzt gespeichert ' + uhrzeit(zeitpunkt) + ' Uhr';
    } else if (zustand === 'leer') {
      statusEl.textContent = 'Noch nichts gespeichert';
    } else {
      statusEl.textContent = 'Speichern auf diesem Gerät nicht möglich – bitte sichere deine Arbeit über die Schaltflächen unten.';
      statusEl.classList.add('slp-status--warn');
    }
  }

  function meldung(text, art) {
    if (!meldungEl) { return; }
    meldungEl.textContent = text;
    meldungEl.className = 'slp-meldung slp-meldung--' + (art || 'info') + ' slp-meldung--sichtbar';
    if (meldungTimer) { clearTimeout(meldungTimer); }
    meldungTimer = setTimeout(function () {
      meldungEl.className = 'slp-meldung';
      meldungEl.textContent = '';
    }, 6000);
  }

  /* ---------- Dialoge (kein confirm/alert) ---------- */

  function dialogOeffnen(optionen) {
    return new Promise(function (aufloesen) {
      var vorherigerFokus = document.activeElement;

      var overlay = el('div', 'slp-overlay');
      var box = el('div', 'slp-dialog');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      var titelId = 'slp-dialog-titel';
      box.setAttribute('aria-labelledby', titelId);

      var titel = el('h2', 'slp-dialog__titel', optionen.titel);
      titel.id = titelId;

      var text = el('p', 'slp-dialog__text', optionen.text);

      var knopfreihe = el('div', 'slp-dialog__knoepfe');
      var abbrechen = el('button', 'slp-btn slp-btn--still', optionen.abbrechenLabel || 'Abbrechen');
      abbrechen.type = 'button';
      var bestaetigen = el('button',
        'slp-btn ' + (optionen.gefahr ? 'slp-btn--gefahr' : 'slp-btn--haupt'),
        optionen.bestaetigenLabel || 'Ja, weiter');
      bestaetigen.type = 'button';

      knopfreihe.appendChild(abbrechen);
      knopfreihe.appendChild(bestaetigen);
      box.appendChild(titel);
      box.appendChild(text);
      box.appendChild(knopfreihe);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function schliessen(ergebnis) {
        document.removeEventListener('keydown', beiTaste, true);
        if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
        if (vorherigerFokus && vorherigerFokus.focus) { vorherigerFokus.focus(); }
        aufloesen(ergebnis);
      }

      function beiTaste(ereignis) {
        if (ereignis.key === 'Escape') {
          ereignis.preventDefault();
          schliessen(false);
          return;
        }
        if (ereignis.key !== 'Tab') { return; }
        // Fokus im Dialog halten
        var fokussierbar = [abbrechen, bestaetigen];
        var index = fokussierbar.indexOf(document.activeElement);
        ereignis.preventDefault();
        var naechster = ereignis.shiftKey
          ? (index <= 0 ? fokussierbar.length - 1 : index - 1)
          : (index === fokussierbar.length - 1 ? 0 : index + 1);
        fokussierbar[naechster].focus();
      }

      abbrechen.addEventListener('click', function () { schliessen(false); });
      bestaetigen.addEventListener('click', function () { schliessen(true); });
      overlay.addEventListener('mousedown', function (ereignis) {
        if (ereignis.target === overlay) { schliessen(false); }
      });
      document.addEventListener('keydown', beiTaste, true);

      // Die abbrechende Schaltflaeche ist vorbelegt.
      abbrechen.focus();
    });
  }

  /* ---------- Zwischenablage ----------
     navigator.clipboard braucht einen sicheren Kontext (https).
     Läuft die Seite über http, greift der ältere Weg über ein
     temporaeres Textfeld. */

  function inZwischenablage(text) {
    if (global.navigator && global.navigator.clipboard && global.isSecureContext) {
      return global.navigator.clipboard.writeText(text).catch(function () {
        return textfeldKopie(text);
      });
    }
    return textfeldKopie(text);
  }

  function textfeldKopie(text) {
    return new Promise(function (aufloesen, ablehnen) {
      var feld = document.createElement('textarea');
      feld.value = text;
      feld.setAttribute('readonly', '');
      feld.style.position = 'fixed';
      feld.style.top = '0';
      feld.style.left = '0';
      feld.style.opacity = '0';
      document.body.appendChild(feld);
      feld.focus();
      feld.setSelectionRange(0, feld.value.length);
      var geklappt = false;
      try { geklappt = document.execCommand('copy'); } catch (fehler) { geklappt = false; }
      document.body.removeChild(feld);
      if (geklappt) { aufloesen(); } else { ablehnen(new Error('Kopieren nicht moeglich')); }
    });
  }

  /* ---------- Export und Import ---------- */

  function exportObjekt() {
    return {
      v: FORMAT_VERSION,
      seite: cfg.seite,
      gespeichert: new Date().toISOString(),
      felder: werteLesen()
    };
  }

  function alsJsonText() {
    return JSON.stringify(exportObjekt(), null, 2);
  }

  function jsonHerunterladen() {
    var name = (cfg.dateiname || cfg.seite) + '_' + heuteFuerDateiname() + '.json';
    var blob = new Blob([alsJsonText()], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    meldung('Sicherung "' + name + '" wurde erstellt. Falls nichts passiert ist, ' +
            'nutze stattdessen "Sicherung kopieren".', 'info');
  }

  function paketPruefen(roh) {
    var paket;
    try {
      paket = JSON.parse(roh);
    } catch (fehler) {
      return { fehler: 'Das ist keine gültige Sicherungsdatei. Bitte kopiere den Text vollständig.' };
    }
    if (!paket || typeof paket !== 'object' || !paket.felder || typeof paket.felder !== 'object') {
      return { fehler: 'In der Sicherung fehlen die gespeicherten Antworten.' };
    }
    if (paket.seite && paket.seite !== cfg.seite) {
      return { fehler: 'Diese Sicherung gehört zur Seite "' + paket.seite + '" und passt nicht zu dieser Seite.' };
    }
    return { paket: paket };
  }

  function importieren(roh) {
    var ergebnis = paketPruefen(roh);
    if (ergebnis.fehler) {
      meldung(ergebnis.fehler, 'fehler');
      return Promise.resolve(false);
    }

    var etwasVorhanden = Object.keys(werteLesen()).length > 0;
    var frage = etwasVorhanden
      ? dialogOeffnen({
          titel: 'Sicherung laden?',
          text: 'Auf dieser Seite stehen bereits Eingaben. Beim Laden der Sicherung ' +
                'werden sie durch den gespeicherten Stand ersetzt.',
          bestaetigenLabel: 'Ersetzen',
          gefahr: true
        })
      : Promise.resolve(true);

    return frage.then(function (ja) {
      if (!ja) { return false; }
      werteSetzen(ergebnis.paket.felder);
      speichern();
      nachAenderung();
      meldung('Sicherung wurde geladen. Du kannst weiterarbeiten.', 'erfolg');
      return true;
    });
  }

  function zuruecksetzen() {
    return dialogOeffnen({
      titel: 'Wirklich alles zurücksetzen?',
      text: 'Alle Eingaben auf dieser Seite werden gelöscht. ' +
            'Das lässt sich nicht rückgängig machen – sichere deine Arbeit vorher, ' +
            'wenn du sie noch brauchst.',
      bestaetigenLabel: 'Alles löschen',
      gefahr: true
    }).then(function (ja) {
      if (!ja) { return false; }
      werteSetzen({});
      try {
        if (speicherMoeglich) { global.localStorage.removeItem(speicherKey); }
      } catch (fehler) { /* nicht schlimm */ }
      statusSetzen(speicherMoeglich ? 'leer' : 'fehler');
      nachAenderung();
      meldung('Alle Eingaben wurden gelöscht.', 'info');
      return true;
    });
  }

  function nachAenderung() {
    if (typeof cfg.nachWiederherstellung === 'function') {
      try { cfg.nachWiederherstellung(); } catch (fehler) {
        console.warn('SLPPersist: Fehler in nachWiederherstellung.', fehler);
      }
    }
  }

  /* ---------- Klartext für die Abgabe ---------- */

  function alsKlartext() {
    if (typeof cfg.klartextQuelle === 'function') {
      return htmlZuText(cfg.klartextQuelle());
    }
    // Allgemeiner Rückfall: Beschriftung und Wert je Feld
    var daten = werteLesen();
    return felder.map(function (feld) {
      var wert = daten[feld.key];
      if (wert === undefined) { return null; }
      if (Array.isArray(wert)) { wert = wert.join(', '); }
      return beschriftung(feld) + ': ' + wert;
    }).filter(Boolean).join('\n');
  }

  function beschriftung(feld) {
    var element = feld.elemente[0];
    if (element.id) {
      var zugeordnet = document.querySelector('label[for="' + element.id + '"]');
      if (zugeordnet) { return zugeordnet.textContent.trim(); }
    }
    var umschliessend = element.closest('label');
    if (umschliessend) { return umschliessend.textContent.trim(); }
    return feld.key;
  }

  /* ---------- Oberfläche des Sicherungsbereichs ---------- */

  function bereichAufbauen() {
    var ziel = document.querySelector(cfg.ziel);
    if (!ziel) {
      console.warn('SLPPersist: Zielelement "' + cfg.ziel + '" nicht gefunden. ' +
                   'Der Sicherungsbereich wird nicht angezeigt.');
      return;
    }

    ziel.classList.add('slp-sicherung');
    ziel.setAttribute('data-slp-ignore', '');

    var titel = el('h3', 'slp-sicherung__titel slp-rule', 'Meine Arbeit sichern');

    var erklaerung = el('p', 'slp-sicherung__text',
      'Diese Seite merkt sich deine Eingaben automatisch – aber nur in diesem Browser ' +
      'auf diesem iPad. Safari löscht gespeicherte Eingaben nach etwa einer Woche, wenn du ' +
      'die Seite nicht wieder öffnest. Deine echte Sicherung ist deshalb die Datei oder der ' +
      'kopierte Text: damit kannst du auch auf einem anderen Gerät weiterarbeiten.');

    statusEl = el('p', 'slp-status');
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');

    var knoepfe = el('div', 'slp-knopfreihe');

    var btnSpeichern = el('button', 'slp-btn slp-btn--haupt', 'Sicherung speichern');
    btnSpeichern.type = 'button';
    btnSpeichern.addEventListener('click', jsonHerunterladen);

    var btnKopieren = el('button', 'slp-btn slp-btn--rand', 'Sicherung kopieren');
    btnKopieren.type = 'button';
    btnKopieren.addEventListener('click', function () {
      inZwischenablage(alsJsonText()).then(function () {
        meldung('Sicherung wurde kopiert. Füge sie zum Weiterarbeiten auf dem anderen ' +
                'Gerät unten bei "Sicherung laden" ein.', 'erfolg');
      }).catch(function () {
        meldung('Kopieren hat nicht geklappt. Markiere den Text im Feld unten und ' +
                'kopiere ihn von Hand.', 'fehler');
        einfuegefeldZeigen(alsJsonText());
      });
    });

    var btnLaden = el('button', 'slp-btn slp-btn--rand', 'Sicherung laden');
    btnLaden.type = 'button';
    btnLaden.setAttribute('aria-expanded', 'false');

    var btnReset = el('button', 'slp-btn slp-btn--still', 'Alles zurücksetzen');
    btnReset.type = 'button';
    btnReset.addEventListener('click', zuruecksetzen);

    knoepfe.appendChild(btnSpeichern);
    knoepfe.appendChild(btnKopieren);
    knoepfe.appendChild(btnLaden);
    knoepfe.appendChild(btnReset);

    /* Laden: Datei ODER eingefuegter Text. Zwei Wege, weil auf
       verwalteten iPads mal der eine, mal der andere klemmt. */
    var ladebereich = el('div', 'slp-laden');
    ladebereich.hidden = true;

    var dateiLabel = el('label', 'slp-laden__label', 'Sicherungsdatei auswählen');
    var dateiFeld = document.createElement('input');
    dateiFeld.type = 'file';
    dateiFeld.accept = 'application/json,.json';
    dateiFeld.className = 'slp-laden__datei';
    dateiFeld.id = 'slp-datei-' + cfg.seite;
    dateiLabel.setAttribute('for', dateiFeld.id);
    dateiFeld.addEventListener('change', function () {
      var datei = dateiFeld.files && dateiFeld.files[0];
      if (!datei) { return; }
      var leser = new FileReader();
      leser.onload = function () {
        importieren(String(leser.result)).then(function (geklappt) {
          if (geklappt) { ladebereich.hidden = true; btnLaden.setAttribute('aria-expanded', 'false'); }
        });
        dateiFeld.value = '';
      };
      leser.onerror = function () {
        meldung('Die Datei konnte nicht gelesen werden.', 'fehler');
      };
      leser.readAsText(datei);
    });

    var textLabel = el('label', 'slp-laden__label', 'oder kopierte Sicherung hier einfügen');
    var textFeld = document.createElement('textarea');
    textFeld.className = 'slp-laden__text';
    textFeld.rows = 4;
    textFeld.placeholder = 'Hier den kopierten Sicherungstext einfügen …';
    textFeld.id = 'slp-text-' + cfg.seite;
    textLabel.setAttribute('for', textFeld.id);

    var btnTextLaden = el('button', 'slp-btn slp-btn--haupt', 'Eingefügte Sicherung laden');
    btnTextLaden.type = 'button';
    btnTextLaden.addEventListener('click', function () {
      var inhalt = textFeld.value.trim();
      if (!inhalt) {
        meldung('Bitte füge zuerst den kopierten Sicherungstext ein.', 'fehler');
        return;
      }
      importieren(inhalt).then(function (geklappt) {
        if (geklappt) {
          textFeld.value = '';
          ladebereich.hidden = true;
          btnLaden.setAttribute('aria-expanded', 'false');
        }
      });
    });

    ladebereich.appendChild(dateiLabel);
    ladebereich.appendChild(dateiFeld);
    ladebereich.appendChild(textLabel);
    ladebereich.appendChild(textFeld);
    ladebereich.appendChild(btnTextLaden);

    btnLaden.addEventListener('click', function () {
      ladebereich.hidden = !ladebereich.hidden;
      btnLaden.setAttribute('aria-expanded', ladebereich.hidden ? 'false' : 'true');
      if (!ladebereich.hidden) { textFeld.focus(); }
    });

    meldungEl = el('p', 'slp-meldung');
    meldungEl.setAttribute('role', 'status');
    meldungEl.setAttribute('aria-live', 'polite');

    ziel.appendChild(titel);
    ziel.appendChild(erklaerung);
    ziel.appendChild(knoepfe);
    ziel.appendChild(statusEl);
    ziel.appendChild(ladebereich);
    ziel.appendChild(meldungEl);

    function einfuegefeldZeigen(inhalt) {
      ladebereich.hidden = false;
      btnLaden.setAttribute('aria-expanded', 'true');
      textFeld.value = inhalt;
      textFeld.focus();
      textFeld.setSelectionRange(0, textFeld.value.length);
    }
  }

  /* ---------- eigenes CSS ----------
     Wird beim Init eingefuegt, damit pro Seite nur eine
     Script-Zeile nötig ist. Nutzt die Tokens aus
     slp-tokens.css, funktioniert aber auch ohne sie
     (die var()-Rückfallwerte greifen dann). */

  function stilEinfuegen() {
    if (stilEingefuegt) { return; }
    stilEingefuegt = true;

    var css = [
      '.slp-sicherung{background:var(--surface-card,#fff);border:1px solid var(--border-subtle,#E2E4E8);',
      'border-radius:var(--radius-lg,10px);box-shadow:var(--shadow-sm,0 1px 3px rgba(16,24,40,.1));',
      'padding:var(--space-5,1.5rem);margin-bottom:var(--space-5,1.5rem);}',

      '.slp-sicherung__titel{margin:0 0 var(--space-3,.75rem);font-size:var(--text-lg,1.375rem);',
      'color:var(--slp-blue,#00509E);}',

      '.slp-sicherung__text{margin:0 0 var(--space-4,1rem);color:var(--text-muted,#5F5F5F);',
      'font-size:var(--text-sm,.875rem);line-height:var(--leading-normal,1.5);max-width:70ch;}',

      '.slp-knopfreihe{display:flex;flex-wrap:wrap;gap:var(--space-3,.75rem);}',

      '.slp-btn{font:inherit;font-weight:700;cursor:pointer;border-radius:var(--radius-md,6px);',
      'padding:.7rem 1.1rem;min-height:44px;border:1px solid transparent;',
      'transition:background var(--dur,200ms) var(--ease-out,ease),',
      'border-color var(--dur,200ms) var(--ease-out,ease),color var(--dur,200ms) var(--ease-out,ease);}',
      '.slp-btn:focus{outline:3px solid var(--focus-ring,#D5EAFF);outline-offset:2px;}',
      '.slp-btn:focus:not(:focus-visible){outline:none;}',
      '.slp-btn:focus-visible{outline:3px solid var(--focus-ring,#D5EAFF);outline-offset:2px;}',
      '.slp-btn:active{transform:translateY(1px);}',

      '.slp-btn--haupt{background:var(--slp-orange,#EB5B25);color:var(--text-on-orange,#fff);}',
      '.slp-btn--haupt:hover{background:var(--accent-2-hover,#CD4900);}',

      '.slp-btn--rand{background:var(--surface-card,#fff);color:var(--slp-blue,#00509E);',
      'border-color:var(--border-default,#CBCED4);}',
      '.slp-btn--rand:hover{background:var(--accent-soft,#EDF6FF);border-color:var(--slp-blue,#00509E);}',

      '.slp-btn--still{background:transparent;color:var(--text-muted,#5F5F5F);',
      'border-color:var(--border-default,#CBCED4);}',
      '.slp-btn--still:hover{background:var(--surface-sunken,#F0F1F3);color:var(--text-body,#333);}',

      '.slp-btn--gefahr{background:var(--danger,#CC2827);color:#fff;}',
      '.slp-btn--gefahr:hover{background:#A81F1E;}',

      '.slp-status{margin:var(--space-4,1rem) 0 0;font-size:var(--text-sm,.875rem);',
      'color:var(--text-muted,#5F5F5F);}',
      '.slp-status--warn{color:var(--danger,#CC2827);font-weight:700;}',

      '.slp-laden{margin-top:var(--space-4,1rem);padding-top:var(--space-4,1rem);',
      'border-top:1px solid var(--border-subtle,#E2E4E8);}',
      '.slp-laden__label{display:block;font-weight:700;font-size:var(--text-sm,.875rem);',
      'margin:var(--space-3,.75rem) 0 var(--space-1,.25rem);color:var(--text-body,#333);}',
      '.slp-laden__datei{display:block;width:100%;font:inherit;font-size:var(--text-sm,.875rem);}',
      '.slp-laden__text{display:block;width:100%;font:inherit;font-size:var(--text-sm,.875rem);',
      'padding:var(--space-3,.75rem);border:1px solid var(--border-default,#CBCED4);',
      'border-radius:var(--radius-md,6px);margin-bottom:var(--space-3,.75rem);resize:vertical;}',
      '.slp-laden__text:focus{outline:3px solid var(--focus-ring,#D5EAFF);outline-offset:1px;',
      'border-color:var(--slp-blue,#00509E);}',

      '.slp-meldung{margin:var(--space-3,.75rem) 0 0;font-size:var(--text-sm,.875rem);',
      'line-height:var(--leading-normal,1.5);padding:0;max-height:0;overflow:hidden;',
      'transition:max-height var(--dur,200ms) var(--ease-out,ease);}',
      '.slp-meldung--sichtbar{max-height:12rem;padding:var(--space-3,.75rem);',
      'border-radius:var(--radius-md,6px);}',
      '.slp-meldung--erfolg{background:var(--success-soft,#E8F5ED);color:var(--success,#298646);}',
      '.slp-meldung--fehler{background:var(--danger-soft,#FDEDEC);color:var(--danger,#CC2827);}',
      '.slp-meldung--info{background:var(--accent-soft,#EDF6FF);color:var(--blue-700,#003D74);}',

      '.slp-overlay{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,30,62,.55);display:flex;',
      'align-items:center;justify-content:center;padding:var(--space-4,1rem);z-index:1000;}',
      '.slp-dialog{background:var(--surface-card,#fff);border-radius:var(--radius-lg,10px);',
      'box-shadow:var(--shadow-lg,0 12px 32px rgba(16,24,40,.14));padding:var(--space-5,1.5rem);',
      'max-width:34rem;width:100%;}',
      '.slp-dialog__titel{margin:0 0 var(--space-3,.75rem);font-size:var(--text-lg,1.375rem);',
      'color:var(--slp-blue,#00509E);}',
      '.slp-dialog__text{margin:0 0 var(--space-5,1.5rem);color:var(--text-body,#333);',
      'line-height:var(--leading-normal,1.5);}',
      '.slp-dialog__knoepfe{display:flex;flex-wrap:wrap;gap:var(--space-3,.75rem);',
      'justify-content:flex-end;}',

      '@media (max-width:560px){.slp-knopfreihe>.slp-btn,.slp-dialog__knoepfe>.slp-btn{width:100%;}}',

      '@supports not (gap:1rem){.slp-knopfreihe>*,.slp-dialog__knoepfe>*{margin:0 var(--space-3,.75rem) var(--space-3,.75rem) 0;}}',

      '@media print{.slp-sicherung,.slp-overlay{display:none !important;}}'
    ].join('');

    var stil = document.createElement('style');
    stil.setAttribute('data-slp', 'persist');
    stil.appendChild(document.createTextNode(css));
    document.head.appendChild(stil);
  }

  /* ---------- Start ---------- */

  function init(optionen) {
    cfg = optionen || {};
    if (!cfg.seite) {
      console.error('SLPPersist: "seite" fehlt in der Konfiguration.');
      return;
    }
    speicherKey = KEY_PRAEFIX + cfg.seite;

    function starten() {
      stilEinfuegen();
      speicherMoeglich = speicherPruefen();
      bereichAufbauen();

      /* Seiten, die ihre Felder erst per Skript erzeugen (die Quizze),
         bauen hier ihren Inhalt passend zum gespeicherten Stand auf.
         Erst danach werden die Felder erfasst - sonst kaeme die
         Wiederherstellung an Elementen an, die es noch gar nicht gibt. */
      var paket = geladenesPaket();
      if (typeof cfg.vorWiederherstellung === 'function') {
        try {
          cfg.vorWiederherstellung(paket ? paket.felder : null);
        } catch (fehler) {
          console.warn('SLPPersist: Fehler in vorWiederherstellung.', fehler);
        }
      }

      felder = felderErfassen();

      var wiederhergestellt = wiederherstellen();
      if (wiederhergestellt) { nachAenderung(); }

      var bereich = document.querySelector(cfg.bereich);
      if (bereich) {
        bereich.addEventListener('input', speichernVerzoegert);
        bereich.addEventListener('change', speichernVerzoegert);
      }

      // Beim Verlassen der Seite noch ausstehende Änderung sichern.
      global.addEventListener('pagehide', function () {
        if (speicherTimer) { clearTimeout(speicherTimer); speicherTimer = null; speichern(); }
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', starten);
    } else {
      starten();
    }
  }

  global.SLPPersist = {
    init: init,
    speichern: speichern,
    /* Nach einem Neuaufbau der Felder per Skript aufrufen, damit der
       Baustein die neuen Elemente kennt. */
    felderNeuEinlesen: function () {
      felder = felderErfassen();
      return felder.length;
    },
    /* Rueckfrage im Seiten-Look, damit Seiten kein confirm() brauchen. */
    frage: function (optionen) { return dialogOeffnen(optionen || {}); },
    hinweis: function (text, art) { meldung(text, art); },
    exportObjekt: exportObjekt,
    importiere: importieren,
    zuruecksetzen: zuruecksetzen,
    alsKlartext: alsKlartext,
    htmlZuText: htmlZuText,
    klartextKopieren: function () {
      return inZwischenablage(alsKlartext()).then(function () {
        meldung('Dein Onepager wurde als Text kopiert. Du kannst ihn jetzt in DiLer einfügen.', 'erfolg');
        return true;
      }).catch(function () {
        meldung('Kopieren hat nicht geklappt. Nutze stattdessen "Als Word-Datei speichern".', 'fehler');
        return false;
      });
    }
  };
})(window);
