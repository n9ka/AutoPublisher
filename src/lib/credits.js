const { supabase } = require('./supabase');

/**
 * Vérifie si un utilisateur a assez de crédits
 */
async function hasEnoughCredits(userId, amount = 1) {
  const { data, error } = await supabase
    .from('user')
    .select('credits_balance')
    .eq('id', userId)
    .single();

  if (error) {
    console.error(`  [Credits] Erreur pour user ${userId}:`, error.message);
    return false;
  }
  if (!data) {
    console.error(`  [Credits] Utilisateur non trouvé: ${userId}`);
    return false;
  }
  return data.credits_balance >= amount;
}

/**
 * Débite un crédit à un utilisateur
 */
async function spendCredit(userId, amount = 1, articleId = null) {
  const { data: user, error: fetchError } = await supabase
    .from('user')
    .select('credits_balance')
    .eq('id', userId)
    .single();

  if (fetchError || user.credits_balance < amount) {
    throw new Error('Crédits insuffisants');
  }

  const { error: updateError } = await supabase
    .from('user')
    .update({ credits_balance: user.credits_balance - amount })
    .eq('id', userId);

  if (updateError) throw updateError;

  // Log de la transaction
  await supabase.from('credit_logs').insert({
    user_id: userId,
    action: 'spend',
    amount: -amount,
    article_id: articleId
  });

  return true;
}

/**
 * Recrédite un utilisateur suite à un échec
 */
async function refundCredit(userId, amount = 1, articleId = null) {
  const { data: user, error: fetchError } = await supabase
    .from('user')
    .select('credits_balance')
    .eq('id', userId)
    .single();

  if (fetchError) {
    console.error(`  [Credits] Erreur refund pour user ${userId}:`, fetchError.message);
    return false;
  }

  const { error: updateError } = await supabase
    .from('user')
    .update({ credits_balance: user.credits_balance + amount })
    .eq('id', userId);

  if (updateError) throw updateError;

  // Log de la transaction
  await supabase.from('credit_logs').insert({
    user_id: userId,
    action: 'refund',
    amount: amount,
    article_id: articleId
  });

  console.log(`  [Credits] Refund de ${amount} crédits effectué pour user ${userId}`);
  return true;
}

module.exports = { hasEnoughCredits, spendCredit, refundCredit };
