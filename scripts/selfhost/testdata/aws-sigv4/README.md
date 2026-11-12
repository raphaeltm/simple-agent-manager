# AWS Signature Version 4 test vectors

Copied unchanged from the AWS signing test suite in
[awslabs/aws-c-auth](https://github.com/awslabs/aws-c-auth) (`tests/aws-signing-test-suite/v4`,
Apache License 2.0), a subset of cases: `request.txt`, `context.json` and the expected
`header-canonical-request.txt`, `header-string-to-sign.txt` and `header-signature.txt`.

The upstream `LICENSE` and `NOTICE` are copied alongside.

`scripts/selfhost/aws-sigv4.test.ts` checks the key agent's signer
(`deploy/selfhost/key-agent/aws-sigv4.ts`) against them, so the AWS KMS fake used by the
conformance suite cannot simply agree with a wrong signer. The credentials are AWS's published
example values, not real ones.
