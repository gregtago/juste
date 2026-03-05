const express = require("express");
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const https = require("https");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const SYSTEM = `Tu es un assistant notarial expert. A partir du document fourni, extrais les donnees de toutes les personnes physiques identifiees et genere UNIQUEMENT un fichier XML conforme au format d'import genealogiste de iNot (Genapi), sans aucun texte autour, sans markdown.

Structure XML :
<?xml version="1.0" encoding="utf-8"?>
<iNova><iNot><Customer><Folder>
  <Person info="">
    [tous les champs dans l'ordre]
    <HistoriqueMarital />
  </Person>
</Folder></Customer></iNot></iNova>

Champs obligatoires dans l'ordre (format : <Var key="X" name="X"><Value>...</Value></Var>) :
NUMERO (ex: 10000001), TYPE (PP), ADR1, ADR2, ADR3 (CP), ADR4 (ville), RCS, VILRCS, CPRCS, CPAYRCS, NUMMB, IDENMB, ACCORD (M/F), ADR1MB, ADR2MB, CPMB, VILLEMB, PRESENCE, INTCONJ, PRECONJ, JODATE, CPVILMA, NOTMA, HISTORIQUE (O/N), INTCONJPURIEL, CODCRU, LVDCRU, CPSTAT, PREFDAT, DEPTDO (nom departement), CPAYDO (FRANCE), CONJ, ETAT (C/M/S/D/V/I/P/A), CODETITRE (M./MME/MELLE), NOMU (NOM MAJUSCULES), PRENOMU, PRENOM, PROF, DATNA (AAAAMMJJ), DEPTNA (nom departement), CPAYNA (FRANCE), DEPMOR, NATION, INCAPABLE, TITRE (Monsieur/Madame/Mademoiselle), DATMOR, DATMA (AAAAMMJJ), CPAYMA (FR), ADR1IMP, ADR2IMP, CPIMP, VILLEIMP, CODERU (CP naissance), LVNARU (VILLE NAISSANCE MAJUSCULES), NOM (NOM ETAT CIVIL MAJUSCULES), REGIME, DATCONTR, DATAN, DATDECL, DATHOM, TGIME, REGPRE, LIEME, NOTME, NOPME

HistoriqueMarital :
- Celibataire : <HistoriqueMarital />
- Marie(e) : <HistoriqueMarital><Evenement><Var key="COTYMA" name="COTYMA"><Value>M</Value></Var><Var key="DAMAMA" name="DAMAMA"><Value>AAAAMMJJ</Value></Var><Var key="LVT1MA" name="LVT1MA"><Value>CP Ville</Value></Var><Var key="LNCOMA" name="LNCOMA"><Value>NOM</Value></Var><Var key="LPCOMA" name="LPCOMA"><Value>Prenoms</Value></Var><Var key="COCRMA" name="COCRMA"><Value></Value></Var></Evenement></HistoriqueMarital>

Codes : ETAT=C/M/S/D/V/I/P/A, CODETITRE=M./MME/MELLE, HISTORIQUE=O/N, REGIME=4 (legal post-1966), 33 (separation de biens), 32 (communaute universelle)
Regles : Noms en MAJUSCULES, prenoms 1ere lettre majuscule, adresse fiscale = domicile si non precisee, tous les champs presents meme vides.
IMPORTANT : Reponds UNIQUEMENT avec le XML brut, sans markdown, sans explication.`;

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/generate", upload.fields([{ name: "file", maxCount: 1 }, { name: "recaptchaToken", maxCount: 1 }]), async (req, res) => {
  try {
    // Verification reCAPTCHA
    const token = req.body?.recaptchaToken;
    if (!token) return res.status(400).json({ error: "Token CAPTCHA manquant" });

    const secretKey = process.env.RECAPTCHA_SECRET_KEY || "6LfgwYAsAAAAAO6TFfKMMtSoBmIadpc6fticsp9I";
    const verifyResult = await new Promise((resolve) => {
      const postData = `secret=${secretKey}&response=${token}`;
      const options = {
        hostname: "www.google.com",
        path: "/recaptcha/api/siteverify",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
      };
      const reqHttp = https.request(options, (res2) => {
        let data = "";
        res2.on("data", chunk => data += chunk);
        res2.on("end", () => resolve(JSON.parse(data)));
      });
      reqHttp.on("error", () => resolve({ success: false }));
      reqHttp.write(postData);
      reqHttp.end();
    });

    if (!verifyResult.success || verifyResult.score < 0.3) {
      return res.status(403).json({ error: "Vérification anti-robot échouée. Veuillez réessayer." });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API manquante" });
    const file = req.files?.file?.[0];
    if (!file) return res.status(400).json({ error: "Aucun fichier reçu" });

    const base64 = file.buffer.toString("base64");
    const isPdf = file.mimetype === "application/pdf";
    const mediaType = isPdf ? "application/pdf" : (file.mimetype || "image/jpeg");

    const contentBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          contentBlock,
          { type: "text", text: "Extrais toutes les personnes physiques identifiées dans ce document et génère le XML iNot complet." }
        ]
      }]
    });

    const xml = message.content.find(b => b.type === "text")?.text?.replace(/```xml|```/g, "").trim() || "";
    const names = [...xml.matchAll(/<Var key="NOMU"[^>]*><Value>([^<]*)<\/Value>/g)]
      .map(m => m[1].toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""))
      .filter(Boolean);
    const filename = names.length > 0 ? `import_inot_${names.join("_")}.XML` : `import_inot_${Date.now()}.XML`;

    res.json({ xml, filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Erreur serveur" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Juste running on port ${PORT}`));
