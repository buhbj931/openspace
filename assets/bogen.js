/* ============================================================
   SLPBogen – Bewertungs- und Reflexionsbögen für Open Space
   Deutsch-Luxemburgisches Schengen-Lyzeum Perl
   ------------------------------------------------------------
   Baut einen Bogen aus einer Beschreibung (FORM) auf:
   - Angaben (Projekt, Datum, Gruppenmitglieder …)
   - Abschnitte: rating (Skala je Kriterium), bipolar (Skala mit
     zwei Polen), individual (Einzelbewertung je Mitglied),
     fields (Freitext)
   - Zwischenspeicher im Browser (localStorage), Sichern und
     Öffnen als JSON-Datei, PDF als echter Text (jsPDF + AutoTable
     aus assets/, kein Fremdhost)

   Vorlage: Bögen von Kolleg*innen (Open_Space, 11/2026). Inhalt
   und Logik sind übernommen, Gestaltung im SLP-Design.

   Einbindung:
     <link rel="stylesheet" href="assets/slp-tokens.css">
     <link rel="stylesheet" href="assets/bogen.css">
     <div id="bogen"></div>
     <script src="assets/bogen.js"></script>
     <script>SLPBogen.init({ id: …, title: …, head: […], sections: […], scale: […] });</script>
   ============================================================ */

(function (global) {
  "use strict";

  var FORM = null;
  var STORE_KEY = "";
  var showMissing = false;
  var root = null;

  /* ---------- Hilfsfunktionen ---------- */

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  function esc(t) {
    return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function starHtml(n) {
    var s = '<span class="stars" aria-hidden="true">';
    for (var i = 0; i < 3; i++) s += '<span class="s' + (i < n ? " on" : "") + '"></span>';
    return s + "</span>";
  }

  function todayIso() {
    var d = new Date();
    var p = function (x) { return String(x).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function formatDate(iso) {
    if (!iso) return "—";
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? m[3] + "." + m[2] + "." + m[1] : iso;
  }

  function safeName(t) {
    return String(t || "").trim().replace(/[^A-Za-z0-9ÄÖÜäöüß\-]+/g, "_").replace(/^_+|_+$/g, "") || "ohne_Name";
  }

  /* ---------- Struktur der Beschreibung ---------- */

  function memberFields() { return FORM.head.filter(function (f) { return f.type === "members"; }); }
  function memberDef(id) { return FORM.head.find(function (f) { return f.id === id && f.type === "members"; }); }
  function indivSections() { return FORM.sections.filter(function (s) { return s.type === "individual"; }); }
  function indName(sec, i, key) { return "ind_" + sec.id + "_" + i + "_" + key; }

  function allFieldDefs() {
    var defs = FORM.head.slice();
    FORM.sections.forEach(function (s) { if (s.type === "fields") defs = defs.concat(s.fields); });
    return defs;
  }

  function allScaleItems() {
    var items = [];
    FORM.sections.forEach(function (s) {
      if (s.type === "rating") s.groups.forEach(function (g) { items = items.concat(g.items); });
      if (s.type === "bipolar") items = items.concat(s.items);
    });
    return items;
  }

  /* ---------- Aufbau ---------- */

  function fieldHtml(f) {
    var mark = f.required ? ' <span class="req" aria-hidden="true">*</span>' : ' <span class="opt">(optional)</span>';
    var req = f.required ? ' aria-required="true"' : "";
    var ph = f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : "";
    if (f.type === "members") {
      return '<fieldset class="wide members" id="' + f.id + '"><legend class="field-label">' + esc(f.label) + mark +
        ' <span class="opt">– Name und Klasse jedes Gruppenmitglieds</span></legend>' +
        '<div id="' + f.id + '-list"></div>' +
        '<button type="button" class="ghost add" data-add="' + f.id + '">+ Gruppenmitglied hinzufügen</button></fieldset>';
    }
    if (f.type === "choice") {
      return '<fieldset class="wide" id="' + f.id + '"><legend class="field-label">' + esc(f.label) + mark + "</legend>" +
        '<div class="choice-row">' + f.options.map(function (o) {
          return '<label class="choice text-choice"><input type="radio" name="' + f.id + '" value="' + esc(o) + '"' + req + '>' +
            '<span class="face">' + esc(o) + "</span></label>";
        }).join("") + "</div></fieldset>";
    }
    var input;
    if (f.type === "textarea") {
      input = '<textarea id="' + f.id + '" name="' + f.id + '"' + ph + req + (f.short ? ' class="short"' : "") + "></textarea>";
    } else if (f.type === "select") {
      input = '<select id="' + f.id + '" name="' + f.id + '"' + req + '><option value="">– bitte wählen –</option>' +
        f.options.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + "</option>"; }).join("") + "</select>";
    } else {
      input = '<input type="' + (f.type === "date" ? "date" : "text") + '" id="' + f.id + '" name="' + f.id + '"' + ph + req + " />";
    }
    return "<div" + (f.type === "textarea" ? ' class="wide"' : "") + '><label class="field-label" for="' + f.id + '">' +
      esc(f.label) + mark + "</label>" + input + "</div>";
  }

  // Skala als Radiogruppe; die Beschriftung (kaum … sehr gut) ist sichtbar
  // und wird vorgelesen, die Sterne sind nur Schmuck.
  function scaleHtml(name) {
    return '<div class="choice-row">' + FORM.scale.map(function (s) {
      return '<label class="choice"><input type="radio" name="' + name + '" value="' + s.v + '">' +
        '<span class="face">' + starHtml(s.stars) + esc(s.label) + "</span></label>";
    }).join("") + "</div>";
  }

  function itemHtml(name, text, extra) {
    return '<fieldset class="item" data-name="' + name + '"><div class="q-wrap"><legend class="q">' + esc(text) + "</legend>" +
      (extra || "") + "</div>" + scaleHtml(name) + "</fieldset>";
  }

  function build() {
    var html = '<section class="card"><h2 class="part-title">Angaben</h2><div class="two-col" id="headFields">' +
      FORM.head.map(fieldHtml).join("") + "</div></section>";

    FORM.sections.forEach(function (sec) {
      html += '<section class="card"><h2 class="part-title">' + esc(sec.title) + "</h2>";
      if (sec.intro) html += '<p class="small">' + esc(sec.intro) + "</p>";
      if (sec.type === "rating") {
        sec.groups.forEach(function (g) {
          html += '<div class="group"><h3>' + esc(g.title) + "</h3>" + (g.sub ? '<p class="sub">' + esc(g.sub) + "</p>" : "");
          g.items.forEach(function (it) { html += itemHtml(it.id, it.text); });
          html += "</div>";
        });
      } else if (sec.type === "bipolar") {
        html += '<div class="group">';
        sec.items.forEach(function (it) {
          html += '<fieldset class="item bip" data-name="' + it.id + '"><legend class="q">' + esc(it.text) + "</legend>" +
            '<div class="poles"><div class="pole neg"><strong>schwach</strong>' + esc(it.neg) + "</div>" + scaleHtml(it.id) +
            '<div class="pole pos"><strong>stark</strong>' + esc(it.pos) + "</div></div></fieldset>";
        });
        html += "</div>";
      } else if (sec.type === "fields") {
        html += '<div class="two-col">' + sec.fields.map(fieldHtml).join("") + "</div>";
      } else if (sec.type === "individual") {
        html += '<div id="indiv-' + sec.id + '"></div>';
      }
      html += "</section>";
    });

    html += '<section class="card"><h2>Fertig? Speichern und als PDF herunterladen</h2>' +
      '<div class="progress-wrap" aria-hidden="true"><div class="progress-bar" id="progressBar"></div></div>' +
      '<p class="status" id="statusText" aria-live="polite"></p>' +
      '<div class="must" id="missingBox" role="alert"><strong>Noch offen:</strong><ul id="missingList"></ul></div>' +
      '<div class="hint" id="toast" role="status" aria-live="polite"><span id="toastText"></span></div>' +
      '<div class="button-row">' +
      '<button class="primary" type="button" id="pdfButton">Als PDF herunterladen</button>' +
      '<button type="button" id="saveButton">Als Datei speichern</button>' +
      '<button class="ghost" type="button" id="openButton">Gespeicherte Datei öffnen</button>' +
      '<button class="ghost" type="button" id="resetButton">Neuer leerer Bogen</button>' +
      '<input type="file" id="openFile" accept=".json,application/json" hidden />' +
      "</div>" +
      '<p class="small">Die Eingaben werden automatisch in diesem Browser zwischengespeichert. Das ist nur eine Hilfe: ' +
      "Safari löscht solche Daten, wenn die Seite einige Tage nicht geöffnet wurde. Sichere den Bogen deshalb mit " +
      "<strong>„Als Datei speichern“</strong>. Die Datei öffnest du später – auch auf einem anderen Gerät – über " +
      "<strong>„Gespeicherte Datei öffnen“</strong>.</p></section>";

    root.innerHTML = html;
    memberFields().forEach(function (f) { renderMembers(f, []); });
    indivSections().forEach(function (s) { renderIndividual(s, []); });
    var d = document.getElementById("datum");
    if (d && !d.value) d.value = todayIso();
  }

  /* ---------- Gruppenmitglieder ---------- */

  function memberRowHtml(f, m, i) {
    var nr = i + 1;
    return '<div class="member-row">' +
      '<input type="text" class="m-name" aria-label="Gruppenmitglied ' + nr + ': Vor- und Nachname" placeholder="Vor- und Nachname" value="' + esc(m.name || "") + '" />' +
      '<select class="m-klasse" aria-label="Gruppenmitglied ' + nr + ': Klasse"><option value="">Klasse</option>' +
      f.options.map(function (o) {
        return '<option value="' + esc(o) + '"' + (o === m.klasse ? " selected" : "") + ">" + esc(o) + "</option>";
      }).join("") + "</select>" +
      '<button type="button" class="rm" aria-label="Gruppenmitglied ' + nr + ' entfernen" title="Zeile entfernen">✕</button></div>';
  }

  function renderMembers(f, list) {
    var rows = (list || []).slice();
    while (rows.length < (f.minRows || 2)) rows.push({ name: "", klasse: "" });
    document.getElementById(f.id + "-list").innerHTML = rows.map(function (m, i) { return memberRowHtml(f, m, i); }).join("");
  }

  function renumberMembers(f) {
    $$("#" + f.id + "-list .member-row").forEach(function (row, i) {
      var nr = i + 1;
      row.querySelector(".m-name").setAttribute("aria-label", "Gruppenmitglied " + nr + ": Vor- und Nachname");
      row.querySelector(".m-klasse").setAttribute("aria-label", "Gruppenmitglied " + nr + ": Klasse");
      row.querySelector(".rm").setAttribute("aria-label", "Gruppenmitglied " + nr + " entfernen");
    });
  }

  function getMembers(id) {
    return $$("#" + id + "-list .member-row").map(function (r) {
      return { name: r.querySelector(".m-name").value.trim(), klasse: r.querySelector(".m-klasse").value };
    }).filter(function (m) { return m.name; });
  }

  function membersText(list) {
    return (list || []).map(function (m) { return m.name + (m.klasse ? " (" + m.klasse + ")" : ""); }).join(", ");
  }

  function onHeadClick(e) {
    var add = e.target.closest("button[data-add]");
    if (add) {
      var f = memberDef(add.dataset.add);
      var list = document.getElementById(f.id + "-list");
      list.insertAdjacentHTML("beforeend", memberRowHtml(f, {}, list.children.length));
      var inputs = $$(".m-name", list);
      inputs[inputs.length - 1].focus();
      onChange();
      return;
    }
    var rm = e.target.closest("button.rm");
    if (rm) {
      var listEl = rm.closest("[id$='-list']");
      var row = rm.closest(".member-row");
      if (listEl.children.length > 1) row.remove();
      else { row.querySelector(".m-name").value = ""; row.querySelector(".m-klasse").value = ""; }
      memberFields().forEach(renumberMembers);
      indivSections().forEach(function (s) { renderIndividual(s); });
      onChange();
    }
  }

  /* ---------- Einzelbewertung der Gruppenmitglieder ---------- */

  function collectIndividual(sec) {
    return $$("#indiv-" + sec.id + " .indiv-card").map(function (card, i) {
      var o = { name: card.dataset.name, klasse: card.dataset.klasse, ratings: {}, note: "", bemerkung: "" };
      sec.competences.forEach(function (c) {
        var r = card.querySelector('input[name="' + indName(sec, i, c.key) + '"]:checked');
        o.ratings[c.key] = r ? r.value : "";
      });
      var n = card.querySelector(".ind-note"); if (n) o.note = n.value;
      var b = card.querySelector(".ind-bem"); if (b) o.bemerkung = b.value.trim();
      return o;
    });
  }

  function renderIndividual(sec, prev) {
    prev = prev || collectIndividual(sec);
    var mf = memberFields()[0];
    var members = mf ? getMembers(mf.id) : [];
    var box = document.getElementById("indiv-" + sec.id);
    if (!members.length) {
      box.innerHTML = '<div class="hint"><span>Oben unter <strong>„Projektgruppe“</strong> die Gruppenmitglieder eintragen – ' +
        "dann erscheint hier für jedes Mitglied ein eigener Bewertungsblock.</span></div>";
      return;
    }
    box.innerHTML = members.map(function (m, i) {
      var h = '<div class="group indiv-card" data-name="' + esc(m.name) + '" data-klasse="' + esc(m.klasse || "") + '"><h3>' + esc(m.name) +
        (m.klasse ? ' <span class="opt">(' + esc(m.klasse) + ")</span>" : "") + "</h3>";
      sec.competences.forEach(function (c) {
        h += itemHtml(indName(sec, i, c.key), c.label, c.sub ? '<p class="sub">' + esc(c.sub) + "</p>" : "");
      });
      h += '<div class="two-col">';
      var noteId = "note_" + sec.id + "_" + i;
      var bemId = "bem_" + sec.id + "_" + i;
      if (sec.noteOptions) {
        h += '<div><label class="field-label" for="' + noteId + '">' + esc(sec.noteLabel) + ' <span class="opt">(optional)</span></label>' +
          '<select class="ind-note" id="' + noteId + '"><option value="">– bitte wählen –</option>' +
          sec.noteOptions.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + "</option>"; }).join("") + "</select></div>";
      }
      h += '<div><label class="field-label" for="' + bemId + '">Bemerkung <span class="opt">(optional)</span></label>' +
        '<input type="text" class="ind-bem" id="' + bemId + '" placeholder="z. B. besondere Stärken, Entwicklungsfelder" /></div>';
      return h + "</div></div>";
    }).join("");

    members.forEach(function (m, i) {
      var p = prev.find(function (x) { return x.name === m.name; });
      if (!p && prev[i] && !members.some(function (mm) { return mm.name === prev[i].name; })) p = prev[i];
      if (!p) return;
      var card = $$(".indiv-card", box)[i];
      sec.competences.forEach(function (c) {
        var val = p.ratings ? p.ratings[c.key] : "";
        $$('input[name="' + indName(sec, i, c.key) + '"]', card).forEach(function (r) { r.checked = String(r.value) === String(val); });
      });
      if (card.querySelector(".ind-note")) card.querySelector(".ind-note").value = p.note || "";
      card.querySelector(".ind-bem").value = p.bemerkung || "";
    });
  }

  /* ---------- Daten lesen / schreiben ---------- */

  function getVal(name) {
    if (memberDef(name)) return membersText(getMembers(name));
    var radios = $$('input[type="radio"][name="' + name + '"]');
    if (radios.length) {
      var c = radios.find(function (r) { return r.checked; });
      return c ? c.value : "";
    }
    var el = document.getElementById(name);
    return el ? el.value.trim() : "";
  }

  function setVal(name, value) {
    var md = memberDef(name);
    if (md) { renderMembers(md, Array.isArray(value) ? value : []); return; }
    var radios = $$('input[type="radio"][name="' + name + '"]');
    if (radios.length) {
      radios.forEach(function (r) { r.checked = String(r.value) === String(value); });
      return;
    }
    var el = document.getElementById(name);
    if (el) el.value = value == null ? "" : value;
  }

  function collect() {
    var data = { form: FORM.id, version: 1, saved: new Date().toISOString(), values: {} };
    allFieldDefs().forEach(function (f) { data.values[f.id] = f.type === "members" ? getMembers(f.id) : getVal(f.id); });
    allScaleItems().forEach(function (it) { data.values[it.id] = getVal(it.id); });
    indivSections().forEach(function (s) { data.values["ind_" + s.id] = collectIndividual(s); });
    return data;
  }

  function restore(data) {
    if (!data || !data.values) return;
    memberFields().forEach(function (f) { if (data.values[f.id] !== undefined) setVal(f.id, data.values[f.id]); });
    Object.keys(data.values).forEach(function (k) {
      if (k.indexOf("ind_") === 0 || memberDef(k)) return;
      setVal(k, data.values[k]);
    });
    indivSections().forEach(function (s) { renderIndividual(s, data.values["ind_" + s.id] || []); });
  }

  /* ---------- Fortschritt / Pflichtangaben ---------- */

  function getMissing() {
    var missing = [];
    allFieldDefs().forEach(function (f) { if (f.required && !getVal(f.id)) missing.push({ id: f.id, label: f.label, kind: "field" }); });
    allScaleItems().forEach(function (it) { if (!getVal(it.id)) missing.push({ id: it.id, label: it.text, kind: "scale" }); });
    indivSections().forEach(function (s) {
      collectIndividual(s).forEach(function (o, i) {
        s.competences.forEach(function (c) {
          if (!o.ratings[c.key]) missing.push({ id: indName(s, i, c.key), label: o.name + ": " + c.label, kind: "scale" });
        });
      });
    });
    return missing;
  }

  function requiredCount() {
    var n = allFieldDefs().filter(function (f) { return f.required; }).length + allScaleItems().length;
    indivSections().forEach(function (s) { n += collectIndividual(s).length * s.competences.length; });
    return n;
  }

  function updateProgress() {
    var total = requiredCount();
    var done = total - getMissing().length;
    document.getElementById("progressBar").style.width = (total ? Math.round((done / total) * 100) : 100) + "%";
    document.getElementById("statusText").textContent = done + " von " + total + " Pflichtangaben ausgefüllt";
  }

  function markMissing(show) {
    $$(".missing").forEach(function (e) { e.classList.remove("missing"); });
    var box = document.getElementById("missingBox");
    if (!show) { box.style.display = "none"; return []; }
    var missing = getMissing();
    missing.forEach(function (m) {
      var el = m.kind === "scale" ? $('.item[data-name="' + m.id + '"]') : document.getElementById(m.id);
      if (el) el.classList.add("missing");
    });
    if (missing.length) {
      document.getElementById("missingList").innerHTML = missing.slice(0, 12).map(function (m) { return "<li>" + esc(m.label) + "</li>"; }).join("") +
        (missing.length > 12 ? "<li>… und " + (missing.length - 12) + " weitere</li>" : "");
      box.style.display = "block";
    } else {
      box.style.display = "none";
    }
    return missing;
  }

  function onChange() {
    updateProgress();
    if (showMissing) markMissing(true);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(collect())); } catch (e) { /* Speicher nicht verfügbar */ }
  }

  function toast(msg) {
    var t = document.getElementById("toast");
    document.getElementById("toastText").innerHTML = msg;
    t.style.display = "flex";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.style.display = "none"; }, 8000);
  }

  /* ---------- Speichern / Öffnen ---------- */

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function baseFileName() {
    return FORM.filePrefix + "_" + safeName(getVal("projekt")) + "_" + (getVal("datum") || todayIso());
  }

  function saveFile() {
    downloadBlob(new Blob([JSON.stringify(collect(), null, 2)], { type: "application/json" }), baseFileName() + ".json");
    toast("Gespeichert als <strong>" + esc(baseFileName()) + ".json</strong>. Diese Datei kannst du später über „Gespeicherte Datei öffnen“ wieder laden.");
  }

  function openFile() {
    var file = this.files && this.files[0];
    if (!file) return;
    var input = this;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (data.form !== FORM.id) {
          toast("Diese Datei gehört zu einem anderen Bogen und kann hier nicht geöffnet werden.");
          return;
        }
        resetFields();
        restore(data);
        onChange();
        toast("Bogen geladen: <strong>" + esc(file.name) + "</strong>");
      } catch (e) {
        toast("Die Datei konnte nicht gelesen werden.");
      }
    };
    reader.readAsText(file);
    input.value = "";
  }

  function resetFields() {
    $$("input, textarea, select", root).forEach(function (el) {
      if (el.type === "radio") el.checked = false;
      else if (el.type !== "file") el.value = "";
    });
    memberFields().forEach(function (f) { renderMembers(f, []); });
    indivSections().forEach(function (s) { renderIndividual(s, []); });
  }

  function resetForm() {
    if (!confirm("Alle Eingaben in diesem Bogen löschen und neu beginnen?")) return;
    resetFields();
    var d = document.getElementById("datum");
    if (d) d.value = todayIso();
    showMissing = false;
    markMissing(false);
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignorieren */ }
    updateProgress();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------- PDF (jsPDF + AutoTable, echter Text) ---------- */

  var jsPdfLaden = null;
  function ladeSkript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  function ladeJsPdf() {
    if (global.jspdf && global.jspdf.jsPDF.API.autoTable) return Promise.resolve();
    if (!jsPdfLaden) {
      jsPdfLaden = ladeSkript("assets/jspdf.umd.min.js")
        .then(function () { return ladeSkript("assets/jspdf.plugin.autotable.min.js"); })
        .catch(function (e) { jsPdfLaden = null; throw e; });
    }
    return jsPdfLaden;
  }

  // Logo als data-URL; klappt nicht (z. B. Datei lokal geöffnet), bleibt es weg
  function ladeLogo() {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext("2d").drawImage(img, 0, 0);
          resolve({ url: c.toDataURL("image/png"), w: img.naturalWidth, h: img.naturalHeight });
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = "assets/openspace-logo.png";
    });
  }

  var BLAU = [0, 80, 158];
  var LABEL = [237, 246, 255];
  var FELD = [240, 241, 243];
  var TEXT = [51, 51, 51];
  var GRAU = [95, 95, 95];
  var GELB = [255, 221, 0];
  var GELB_RAND = [205, 160, 0];
  var STERN_LEER = [203, 206, 212];
  var RAND = 15;
  var BREITE = 210 - 2 * RAND;

  // Die Standardschrift kennt nur Windows-1252 – alles andere wird zu „?“
  var CP1252_ZUSATZ = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  function pdfText(text) {
    return String(text == null ? "" : text)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, " ")
      .replace(/[^\n\x20-\x7E\xA0-\xFF]/gu, function (ch) { return CP1252_ZUSATZ.indexOf(ch) >= 0 ? ch : "?"; });
  }

  // Schengen-Stern als Fläche zeichnen (die Schrift kennt kein ★)
  function stern(doc, cx, cy, r, voll) {
    var pts = [];
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5;
      var rr = i % 2 === 0 ? r : r * 0.42;
      pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
    var rel = [];
    for (var j = 1; j < pts.length; j++) rel.push([pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]]);
    doc.setLineWidth(0.15);
    if (voll) { doc.setFillColor.apply(doc, GELB); doc.setDrawColor.apply(doc, GELB_RAND); }
    else { doc.setFillColor(255, 255, 255); doc.setDrawColor.apply(doc, STERN_LEER); }
    doc.lines(rel, pts[0][0], pts[0][1], [1, 1], "FD", true);
  }
  function sterne(doc, cx, y, n) {
    var r = 1.5, abst = 3.4;
    for (var i = 0; i < 3; i++) stern(doc, cx + (i - 1) * abst, y, r, i < n);
  }
  function scaleOf(val) { return FORM.scale.find(function (s) { return String(s.v) === String(val); }); }

  var STIL = { font: "helvetica", fontSize: 9.5, textColor: TEXT, cellPadding: 2, lineColor: 255, lineWidth: 0.6, valign: "middle" };
  function rand() { return { left: RAND, right: RAND, top: RAND, bottom: RAND + 6 }; }
  function nextY(doc, gap) { return doc.lastAutoTable ? doc.lastAutoTable.finalY + (gap || 5) : RAND + 24; }

  function sectionHead(titel, span) {
    return [{ content: pdfText(titel), colSpan: span, styles: { fillColor: BLAU, textColor: 255, fontStyle: "bold", fontSize: 11, halign: "left" } }];
  }

  // Kopfzeile mit den Skalenstufen; die Sterne zeichnet didDrawCell
  function scaleHeadRow(erste) {
    return [{ content: pdfText(erste), styles: { halign: "left", valign: "bottom" } }].concat(FORM.scale.map(function (s) {
      return { content: pdfText(s.label), styles: { halign: "center", valign: "bottom" }, stars: s.stars };
    }));
  }

  function ratingTable(doc, sec, v) {
    var spalte = 19;
    var body = [];
    if (sec.type === "rating") {
      sec.groups.forEach(function (g) {
        body.push([{ content: pdfText(g.title + (g.sub ? " (" + g.sub + ")" : "")), colSpan: FORM.scale.length + 1,
          styles: { fillColor: LABEL, textColor: BLAU, fontStyle: "bold" } }]);
        g.items.forEach(function (it) {
          body.push([{ content: pdfText(it.text), styles: { fillColor: FELD } }].concat(FORM.scale.map(function (s) {
            return { content: String(v[it.id]) === String(s.v) ? "X" : "", styles: { fillColor: FELD } };
          })));
        });
      });
    } else {
      sec.items.forEach(function (it) {
        body.push([{ content: pdfText(it.text) + "\n" + pdfText("schwach: " + it.neg) + "\n" + pdfText("stark: " + it.pos),
          styles: { fillColor: FELD }, bip: true }].concat(FORM.scale.map(function (s) {
          return { content: String(v[it.id]) === String(s.v) ? "X" : "", styles: { fillColor: FELD } };
        })));
      });
    }
    var cols = { 0: { cellWidth: BREITE - spalte * FORM.scale.length } };
    FORM.scale.forEach(function (s, i) { cols[i + 1] = { cellWidth: spalte, halign: "center", fontStyle: "bold", fontSize: 12, textColor: BLAU }; });

    doc.autoTable({
      startY: nextY(doc),
      margin: rand(),
      theme: "plain",
      head: [sectionHead(sec.title, FORM.scale.length + 1), scaleHeadRow("Kriterium")],
      body: body,
      rowPageBreak: "avoid",
      styles: STIL,
      headStyles: { fillColor: [248, 248, 248], textColor: TEXT, fontStyle: "bold", fontSize: 8.5, minCellHeight: 10 },
      columnStyles: cols,
      didParseCell: function (d) {
        if (d.section === "body" && d.column.index === 0 && d.cell.raw && d.cell.raw.bip) {
          d.cell.styles.fontSize = 9;
        }
      },
      didDrawCell: function (d) {
        if (d.section === "head" && d.cell.raw && d.cell.raw.stars !== undefined) {
          sterne(doc, d.cell.x + d.cell.width / 2, d.cell.y + 3, d.cell.raw.stars);
        }
      }
    });
  }

  function individualTable(doc, sec, v) {
    var list = v["ind_" + sec.id] || [];
    var hatNote = !!sec.noteOptions;
    var nameBreite = 40;
    var noteBreite = hatNote ? 20 : 0;
    var spalte = (BREITE - nameBreite - noteBreite) / sec.competences.length;
    var head2 = [{ content: "Gruppenmitglied", styles: { halign: "left" } }].concat(sec.competences.map(function (c) {
      return { content: pdfText(c.label), styles: { halign: "center" } };
    }));
    if (hatNote) head2.push({ content: "Note", styles: { halign: "center" } });
    var span = sec.competences.length + 1 + (hatNote ? 1 : 0);

    var body = list.length ? list.map(function (o) {
      var row = [{ content: pdfText(o.name + (o.klasse ? " (" + o.klasse + ")" : "")), styles: { fillColor: FELD, fontStyle: "bold" } }];
      sec.competences.forEach(function (c) {
        var s = scaleOf(o.ratings[c.key]);
        row.push({ content: s ? pdfText(s.label) : "—", styles: { fillColor: FELD, halign: "center", valign: "bottom", minCellHeight: 11 },
          stars: s ? s.stars : undefined });
      });
      if (hatNote) row.push({ content: pdfText(o.note || "—"), styles: { fillColor: FELD, halign: "center", fontStyle: "bold", textColor: BLAU } });
      return row;
    }) : [[{ content: "—", colSpan: span, styles: { fillColor: FELD } }]];

    var cols = { 0: { cellWidth: nameBreite } };
    sec.competences.forEach(function (c, i) { cols[i + 1] = { cellWidth: spalte }; });
    if (hatNote) cols[sec.competences.length + 1] = { cellWidth: noteBreite };

    doc.autoTable({
      startY: nextY(doc),
      margin: rand(),
      theme: "plain",
      head: [sectionHead(sec.title, span), head2],
      body: body,
      rowPageBreak: "avoid",
      styles: STIL,
      headStyles: { fillColor: [248, 248, 248], textColor: TEXT, fontStyle: "bold", fontSize: 7.5, valign: "bottom", cellPadding: { top: 2, bottom: 2, left: 1, right: 1 } },
      columnStyles: cols,
      didDrawCell: function (d) {
        if (d.section === "body" && d.cell.raw && d.cell.raw.stars !== undefined) {
          sterne(doc, d.cell.x + d.cell.width / 2, d.cell.y + 3.2, d.cell.raw.stars);
        }
      }
    });

    var bem = list.filter(function (o) { return o.bemerkung; });
    if (bem.length) {
      boxTable(doc, "Bemerkungen zu den Gruppenmitgliedern", bem.map(function (o) {
        return [{ content: pdfText(o.name), styles: { fillColor: LABEL, textColor: BLAU, fontStyle: "bold", cellWidth: 40 } },
          { content: pdfText(o.bemerkung), styles: { fillColor: FELD } }];
      }), 2);
    }
  }

  function boxTable(doc, titel, zeilen, span) {
    doc.autoTable({
      startY: nextY(doc, 4),
      margin: rand(),
      theme: "plain",
      head: [[{ content: pdfText(titel), colSpan: span || 1,
        styles: { textColor: BLAU, fontStyle: "bold", fontSize: 10, lineWidth: { top: 0.8 }, lineColor: BLAU } }]],
      body: zeilen,
      showHead: "firstPage",
      rowPageBreak: "avoid",
      pageBreak: "avoid",
      styles: Object.assign({}, STIL, { valign: "top", fontSize: 10 })
    });
  }

  function fieldsTables(doc, sec, v) {
    doc.autoTable({
      startY: nextY(doc),
      margin: rand(),
      theme: "plain",
      head: [sectionHead(sec.title, 1)],
      body: [],
      styles: STIL
    });
    sec.fields.forEach(function (f) {
      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 1,
        margin: rand(),
        theme: "plain",
        body: [
          [{ content: pdfText(f.label), styles: { fillColor: LABEL, textColor: BLAU, fontStyle: "bold", fontSize: 9 } }],
          [{ content: pdfText(v[f.id] || "—"), styles: { fillColor: FELD, minCellHeight: 14, valign: "top" } }]
        ],
        rowPageBreak: "avoid",
        pageBreak: "avoid",
        styles: Object.assign({}, STIL, { fontSize: 10 })
      });
    });
  }

  function buildPdf(logo) {
    var v = collect().values;
    var doc = new global.jspdf.jsPDF({ unit: "mm", format: "a4" });

    // Kopf: Schule, Titel, Logo rechts
    var logoH = 18;
    if (logo) doc.addImage(logo.url, "PNG", 210 - RAND - logoH * logo.w / logo.h, RAND - 2, logoH * logo.w / logo.h, logoH, "logo", "FAST");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, GRAU);
    doc.text(pdfText("Deutsch-Luxemburgisches Schengen-Lyzeum Perl · Open Space"), RAND, RAND + 2);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(17);
    doc.setTextColor.apply(doc, BLAU);
    doc.text(pdfText(FORM.title), RAND, RAND + 10);
    doc.setDrawColor.apply(doc, BLAU);
    doc.setLineWidth(0.8);
    doc.line(RAND, RAND + 18, 210 - RAND, RAND + 18);

    // Angaben als Raster: Label hellblau, Inhalt grau
    var heads = FORM.head.filter(function (f) { return f.type !== "members"; });
    var meta = [];
    var lab = function (t) { return { content: pdfText(t), styles: { fillColor: LABEL, textColor: BLAU, fontStyle: "bold", fontSize: 8.5 } }; };
    var val = function (t, span) { return { content: pdfText(t), colSpan: span || 1, styles: { fillColor: FELD } }; };
    var wert = function (f) {
      if (f.type === "date") return formatDate(v[f.id]);
      return v[f.id] || "—";
    };
    for (var i = 0; i < heads.length; i += 2) {
      var a = heads[i], b = heads[i + 1];
      if (b) meta.push([lab(a.label), val(wert(a)), lab(b.label), val(wert(b))]);
      else meta.push([lab(a.label), val(wert(a), 3)]);
    }
    memberFields().forEach(function (f) {
      var list = v[f.id] || [];
      meta.push([lab(f.label), val(list.length ? list.map(function (m) { return m.name + (m.klasse ? " (" + m.klasse + ")" : ""); }).join("\n") : "—", 3)]);
    });
    doc.autoTable({
      startY: RAND + 22,
      margin: rand(),
      theme: "plain",
      body: meta,
      styles: Object.assign({}, STIL, { valign: "top" }),
      columnStyles: { 0: { cellWidth: 32 }, 1: { cellWidth: BREITE / 2 - 32 }, 2: { cellWidth: 32 }, 3: { cellWidth: BREITE / 2 - 32 } }
    });

    FORM.sections.forEach(function (sec) {
      if (sec.type === "rating" || sec.type === "bipolar") ratingTable(doc, sec, v);
      else if (sec.type === "individual") individualTable(doc, sec, v);
      else if (sec.type === "fields") fieldsTables(doc, sec, v);
    });

    // Fußzeile auf jeder Seite
    var projekt = v.projekt ? FORM.title + " · " + v.projekt : FORM.title;
    var seiten = doc.getNumberOfPages();
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, GRAU);
    for (var p = 1; p <= seiten; p++) {
      doc.setPage(p);
      doc.text(doc.splitTextToSize(pdfText(projekt + " · erstellt am " + formatDate(todayIso())), BREITE - 30)[0], RAND, 297 - RAND + 4);
      doc.text("Seite " + p + " von " + seiten, 210 - RAND, 297 - RAND + 4, { align: "right" });
    }
    return doc;
  }

  function downloadPdf() {
    showMissing = true;
    var missing = markMissing(true);
    if (missing.length) {
      toast("Hinweis: Es sind noch <strong>" + missing.length + "</strong> Pflichtangaben offen (rot markiert). Das PDF wird trotzdem erstellt.");
    }
    var button = document.getElementById("pdfButton");
    var label = button.textContent;
    button.disabled = true;
    button.textContent = "PDF wird erstellt …";
    ladeJsPdf()
      .then(ladeLogo)
      .then(function (logo) { buildPdf(logo).save(baseFileName() + ".pdf"); })
      .catch(function () {
        alert("Das PDF konnte nicht erstellt werden. Bitte die Seite neu laden und es noch einmal versuchen.");
      })
      .then(function () { button.disabled = false; button.textContent = label; });
  }

  /* ---------- Start ---------- */

  function init(form) {
    FORM = form;
    STORE_KEY = "openspace-bogen-" + FORM.id;
    root = document.getElementById("bogen");
    build();
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved) restore(JSON.parse(saved));
    } catch (e) { /* kein Zwischenspeicher */ }

    document.getElementById("headFields").addEventListener("click", onHeadClick);
    document.getElementById("headFields").addEventListener("change", function (e) {
      if (e.target.matches(".m-name, .m-klasse")) indivSections().forEach(function (s) { renderIndividual(s); });
    });
    root.addEventListener("input", onChange);
    root.addEventListener("change", onChange);
    document.getElementById("pdfButton").addEventListener("click", downloadPdf);
    document.getElementById("saveButton").addEventListener("click", saveFile);
    document.getElementById("openButton").addEventListener("click", function () { document.getElementById("openFile").click(); });
    document.getElementById("openFile").addEventListener("change", openFile);
    document.getElementById("resetButton").addEventListener("click", resetForm);
    updateProgress();
  }

  global.SLPBogen = { init: init, _buildPdf: buildPdf, _ladeJsPdf: ladeJsPdf, _ladeLogo: ladeLogo };
})(window);
