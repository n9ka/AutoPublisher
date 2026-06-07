require('dotenv').config();
const {
  isPublishCacheEnabled,
  savePublishPayload,
  markPublishFailed,
  markPublishSucceeded,
  getPublishPayload,
  listPublishPayloads,
} = require('./lib/publish-cache');

async function main() {
  if (!isPublishCacheEnabled()) {
    throw new Error('Publish cache désactivé ou PUBLISH_CACHE_DATABASE_URL manquante');
  }

  const testJobId = '00000000-0000-0000-0000-000000000001';
  const payload = {
    title: 'Test publish cache',
    content: '<p>Test payload</p>',
    slug: 'test-publish-cache',
    created_by: 'github-actions',
    _retry_meta: {
      credits_to_charge: 0,
      request_indexing: false,
    },
  };

  const site = {
    id: testJobId,
    url: 'https://example.com',
    name: 'Test Site',
  };

  console.log('🔌 Publish cache activé');

  const saved = await savePublishPayload({
    jobId: testJobId,
    sourceKind: 'test',
    site,
    payload,
  });
  console.log(`✅ savePublishPayload: ${saved}`);

  const fetchedAfterSave = await getPublishPayload(testJobId);
  console.log('📦 Après save :');
  console.log(JSON.stringify({
    job_id: fetchedAfterSave?.job_id,
    source_kind: fetchedAfterSave?.source_kind,
    site_url: fetchedAfterSave?.site_url,
    publish_status: fetchedAfterSave?.publish_status,
  }, null, 2));

  const failed = await markPublishFailed(testJobId, 'test failure');
  console.log(`✅ markPublishFailed: ${failed}`);

  const fetchedAfterFailed = await getPublishPayload(testJobId);
  console.log('📦 Après mark failed :');
  console.log(JSON.stringify({
    publish_status: fetchedAfterFailed?.publish_status,
    attempts: fetchedAfterFailed?.attempts,
    last_error: fetchedAfterFailed?.last_error,
  }, null, 2));

  const published = await markPublishSucceeded(testJobId, 'https://example.com/test-publish-cache');
  console.log(`✅ markPublishSucceeded: ${published}`);

  const fetchedAfterPublished = await getPublishPayload(testJobId);
  console.log('📦 Après mark published :');
  console.log(JSON.stringify({
    publish_status: fetchedAfterPublished?.publish_status,
    published_url: fetchedAfterPublished?.published_url,
  }, null, 2));

  const listed = await listPublishPayloads({ limit: 5 });
  console.log(`📚 listPublishPayloads: ${listed.length} ligne(s)`);
}

main().catch((error) => {
  console.error('❌ Test publish cache échoué:', error.message);
  process.exit(1);
});
