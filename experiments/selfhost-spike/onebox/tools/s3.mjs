// Tiny S3 helper. usage: node s3.mjs <ls|get|head|grep|presign-put|presign-get|put> BUCKET [KEY|PREFIX|NEEDLE] [...]
// Reads S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION.
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.AWS_REGION || 'us-east-1', forcePathStyle: true });
const [cmd, Bucket, arg, ...rest] = process.argv.slice(2);
async function* all(Prefix = '') { let ContinuationToken; do { const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken })); for (const o of r.Contents || []) yield o; ContinuationToken = r.NextContinuationToken; } while (ContinuationToken); }
const body = async (Key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray());
if (cmd === 'ls') { let n = 0, b = 0; for await (const o of all(arg)) { n++; b += o.Size; if (!rest.includes('-q')) console.log(o.Size, o.Key); } console.log(`# ${n} objects, ${b} bytes`); }
if (cmd === 'get') process.stdout.write(await body(arg));
if (cmd === 'head') console.log(JSON.stringify(await s3.send(new HeadObjectCommand({ Bucket, Key: arg })), null, 1));
if (cmd === 'grep') { for await (const o of all(rest[0] || '')) { if (o.Size > 50e6) continue; const b = await body(o.Key); if (b.includes(arg)) console.log('MATCH', o.Key, o.Size); } }
if (cmd === 'presign-put') console.log(await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: arg, ContentType: rest[0] }), { expiresIn: 600 }));
if (cmd === 'presign-get') console.log(await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: arg }), { expiresIn: 600 }));
