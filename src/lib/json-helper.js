/**
 * json-helper.js - Fonctions de secours pour le parsing JSON des LLM
 * Version SÉCURISÉE ET AMÉLIORÉE avec détection de troncature
 */

function repairJson(text) {
  if (!text) return { json: "{}", isTruncated: false };
  let cleaned = text.trim();

  // 1. Extraire uniquement depuis la première {
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return { json: "{}", isTruncated: false };
  cleaned = cleaned.substring(firstBrace);

  // 2. Gérer les sauts de ligne physiques et les caractères d'échappement invalides
  let inQuote = false;
  let result = "";
  let openBraces = 0;
  let openBrackets = 0;
  let wasTruncated = false;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const nextChar = cleaned[i + 1];

    // Détection de début/fin de guillemets (en ignorant les échappés)
    if (char === '"' && (i === 0 || cleaned[i - 1] !== '\\')) {
      inQuote = !inQuote;
    }

    if (inQuote) {
      // DANS UNE VALEUR (STRING)
      if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\\') {
        // RÉPARATION CRITIQUE : Vérifier si l'échappement est valide JSON
        // S'il n'est pas suivi d'un caractère valide (\", \\, \/, \b, \f, \n, \r, \t, \u)
        // on DOIT le doubler pour le rendre littéral, sinon JSON.parse échoue (Bad escaped character)
        const validEscapes = ['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'];
        if (!nextChar || !validEscapes.includes(nextChar)) {
          result += '\\\\'; // On double le backslash
        } else {
          result += char;
        }
      } else {
        result += char;
      }
    } else {
      // HORS STRING (STRUCTURE JSON)
      if (char === '{') openBraces++;
      if (char === '}') {
        if (openBraces > 0) {
          openBraces--;
          result += char;
        }
        continue;
      }
      if (char === '[') openBrackets++;
      if (char === ']') {
        if (openBrackets > 0) {
          openBrackets--;
          result += char;
        }
        continue;
      }
      result += char;
    }
  }

  // 3. Détection de la troncature physique
  if (inQuote || openBraces > 0 || openBrackets > 0) {
    wasTruncated = true;
  }

  // 4. Fermeture automatique
  if (inQuote) result += '"';
  
  result = result.trim().replace(/,$/, '');

  while (openBrackets > 0) {
    result += ']';
    openBrackets--;
  }
  while (openBraces > 0) {
    result += '}';
    openBraces--;
  }

  // 5. Nettoyage des virgules traînantes internes
  result = result.replace(/,\s*([}\]])/g, '$1');

  return {
    json: result,
    isTruncated: wasTruncated
  };
}

module.exports = { repairJson };
