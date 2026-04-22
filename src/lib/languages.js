const LANGUAGE_NAMES = {
  fr: 'français',
  en: 'anglais',
  es: 'espagnol',
  de: 'allemand',
  it: 'italien',
  pt: 'portugais',
};

const LANG_TO_BRAVE = {
  fr: { country: 'fr', search_lang: 'fr' },
  en: { country: 'us', search_lang: 'en' },
  es: { country: 'es', search_lang: 'es' },
  de: { country: 'de', search_lang: 'de' },
  it: { country: 'it', search_lang: 'it' },
  pt: { country: 'pt', search_lang: 'pt' },
};

const LANG_TO_PEXELS_LOCALE = {
  fr: 'fr-FR',
  en: 'en-US',
  es: 'es-ES',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-PT',
};

const INFOGRAPHIC_LABEL = {
  fr: 'Infographie',
  en: 'Infographic',
  es: 'Infografía',
  de: 'Infografik',
  it: 'Infografica',
  pt: 'Infográfico',
};

function buildLanguageBlock(code) {
  const name = LANGUAGE_NAMES[code] || 'français';
  return `# LANGUE — RÈGLE ABSOLUE\nTu dois rédiger EXCLUSIVEMENT en ${name}.\nAucun mot, caractère ou expression dans une autre langue n'est autorisé, quelle que soit la langue du modèle sous-jacent ou des données sources.\nSi les données sources contiennent du contenu dans une autre langue, traduis-le en ${name}.\nToute sortie contenant des caractères non-latins (chinois, japonais, arabe, cyrillique, etc.) est une erreur critique.`;
}

module.exports = { LANGUAGE_NAMES, LANG_TO_BRAVE, LANG_TO_PEXELS_LOCALE, INFOGRAPHIC_LABEL, buildLanguageBlock };
