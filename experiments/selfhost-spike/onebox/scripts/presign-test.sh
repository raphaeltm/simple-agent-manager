#!/usr/bin/env bash
# Item 6: can a presigned URL against the operator's bucket replace R2 presigning?
# usage: presign-test.sh <minio|seaweedfs>   (node must be running on 127.0.0.1:8080)
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; . "$HERE/scripts/node-env.sh" "$1"
B=http://127.0.0.1:8080; T=$(mktemp -d); S3="node $HERE/tools/s3.mjs"; FLEET=celld-fleet; R2=onebox-files
head -c 3145728 /dev/urandom > $T/a.bin; SHA=$(sha256sum < $T/a.bin | cut -c1-16)
echo "== A) presigned PUT to store at r2/$R2/direct/a.bin (no celld metadata header) -> read via binding"
URL=$($S3 presign-put $FLEET r2/$R2/direct/a.bin application/octet-stream)
curl -s -o /dev/null -w 'store PUT %{http_code}\n' -X PUT -H 'content-type: application/octet-stream' --data-binary @$T/a.bin "$URL"
echo "binding head: $(curl -s "$B/r2/direct/a.bin?head")" | tr -d '\n '; echo
echo "binding GET sha=$(curl -s "$B/r2/direct/a.bin" | sha256sum | cut -c1-16) want=$SHA"
echo "binding list: $(curl -s "$B/r2list?prefix=direct/" | tr -d '\n ')"
echo "== A2) presigned PUT carrying x-amz-meta-celld-r2 (client sends the header)"
META='{"custom":{"uploader":"presign"},"http":{"contentType":"image/png"}}'
URL=$(node -e '
import("@aws-sdk/client-s3").then(async ({S3Client,PutObjectCommand})=>{const {getSignedUrl}=await import("@aws-sdk/s3-request-presigner");
const s3=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.AWS_REGION,forcePathStyle:true});
console.log(await getSignedUrl(s3,new PutObjectCommand({Bucket:process.argv[1],Key:process.argv[2],ContentType:"image/png",Metadata:{"celld-r2":process.argv[3]}}),{expiresIn:600}))})' $FLEET r2/$R2/direct/b.png "$META" 2>&1)
cd "$HERE/tools" >/dev/null
URL=$(node --input-type=module -e '
import {S3Client,PutObjectCommand} from "@aws-sdk/client-s3"; import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
const s3=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.AWS_REGION,forcePathStyle:true});
console.log(await getSignedUrl(s3,new PutObjectCommand({Bucket:process.argv[1],Key:process.argv[2],ContentType:"image/png",Metadata:{"celld-r2":process.argv[3]}}),{expiresIn:600, unhoistableHeaders:new Set(["x-amz-meta-celld-r2"])}))' $FLEET r2/$R2/direct/b.png "$META")
curl -s -o /dev/null -w 'store PUT %{http_code}\n' -X PUT -H 'content-type: image/png' -H "x-amz-meta-celld-r2: $META" --data-binary @$T/a.bin "$URL"
echo "binding head: $(curl -s "$B/r2/direct/b.png?head")" | tr -d '\n '; echo
echo "== B) PUT via binding -> presigned GET from store"
curl -s -o /dev/null -XPUT -H 'content-type: application/pdf' -H 'x-meta-owner: worker' --data-binary @$T/a.bin "$B/r2/viaworker/c.pdf"
URL=$($S3 presign-get $FLEET r2/$R2/viaworker/c.pdf)
curl -s -D $T/h -o $T/c.bin "$URL"; echo "store GET $(head -1 $T/h | tr -d '\r') sha=$(sha256sum < $T/c.bin | cut -c1-16) want=$SHA ct=$(grep -i '^content-type' $T/h | tr -d '\r')"
echo "== C) 40 MiB object via binding: single store object or chunks?"
head -c 41943040 /dev/urandom > $T/big.bin; BSHA=$(sha256sum < $T/big.bin | cut -c1-16)
curl -s -XPUT --data-binary @$T/big.bin "$B/r2/viaworker/big.bin" | tr -d '\n '; echo
$S3 ls $FLEET r2/$R2/viaworker/
URL=$($S3 presign-get $FLEET r2/$R2/viaworker/big.bin); echo "store GET sha=$(curl -s "$URL" | sha256sum | cut -c1-16) want=$BSHA"
echo "== D) 40 MiB presigned PUT to store -> binding GET"
URL=$($S3 presign-put $FLEET r2/$R2/direct/big2.bin application/octet-stream)
curl -s -o /dev/null -w 'store PUT %{http_code}\n' -X PUT -H 'content-type: application/octet-stream' --data-binary @$T/big.bin "$URL"
echo "binding GET sha=$(curl -s "$B/r2/direct/big2.bin" | sha256sum | cut -c1-16) want=$BSHA; head: $(curl -s "$B/r2/direct/big2.bin?head" | jq -c '{size,etag,httpMetadata}')"
rm -rf $T
