const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Doit faire 32 caractères

/**
 * Chiffre un texte
 */
function encrypt(text) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY manquante');
  
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return {
    content: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag
  };
}

/**
 * Déchiffre un texte
 */
function decrypt(encryptedContent, ivHex, authTagHex) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY manquante');

  const decipher = crypto.createDecipheriv(
    ALGORITHM, 
    Buffer.from(ENCRYPTION_KEY), 
    Buffer.from(ivHex, 'hex')
  );
  
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  
  let decrypted = decipher.update(encryptedContent, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

module.exports = { encrypt, decrypt };
