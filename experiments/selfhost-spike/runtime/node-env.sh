# source me: throwaway env for a real celld node against local MinIO (container trackA-minio).
export PATH=/tmp/spike/bin:$PATH
export CELLD_BUCKET=s3://celld-fleet S3_ENDPOINT=http://127.0.0.1:9100
export AWS_ACCESS_KEY_ID=spikeadmin AWS_SECRET_ACCESS_KEY=spikeadmin-throwaway AWS_REGION=us-east-1
