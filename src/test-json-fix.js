const { repairJson } = require('./lib/json-helper');

const brokenJson = `{
    "title": "Article Test",
    "content": "Voici un texte avec un backslash invalide \\$ pour tester le crash.",
    "list": [
        {
            "point": "L'IA a oublié de fermer un guillemet ici
            "next": "Et elle a rajouté du texte libre après le JSON"
        }
    ]
}
Et ici du blabla hors JSON...`;

console.log("--- TEST REPAIR JSON ---");
console.log("Original (cassé):");
console.log(brokenJson);

try {
  JSON.parse(brokenJson);
} catch (e) {
  console.log("\n❌ JSON.parse standard a échoué (comme prévu):", e.message);
}

const fixed = repairJson(brokenJson);
console.log("\n--- Version Réparée ---");
console.log(fixed);

try {
  const parsed = JSON.parse(fixed);
  console.log("\n✅ SUCCÈS ! JSON.parse a accepté la version réparée.");
  console.log("Contenu extrait:", parsed.content);
} catch (e) {
  console.log("\n❌ ÉCHEC même après réparation:", e.message);
}
