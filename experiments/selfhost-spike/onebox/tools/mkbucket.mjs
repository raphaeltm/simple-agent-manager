// usage: node mkbucket.mjs ENDPOINT KEY SECRET REGION BUCKET
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
const [endpoint, accessKeyId, secretAccessKey, region, Bucket] = process.argv.slice(2);
const s3 = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
try { await s3.send(new CreateBucketCommand({ Bucket })); console.log('created', Bucket); }
catch (e) { console.log(e.name, e.message); }
