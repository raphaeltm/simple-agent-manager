import noInlineMarkdownComponents from './rules/no-inline-markdown-components.js';
import noLocalRecordGuard from './rules/no-local-record-guard.js';
import noUnguardedOutboundFetch from './rules/no-unguarded-outbound-fetch.js';
import noUnsafeJsonParseAssertion from './rules/no-unsafe-json-parse-assertion.js';
import noUnvalidatedRequestJson from './rules/no-unvalidated-request-json.js';

const rules = {
  'no-inline-markdown-components': noInlineMarkdownComponents,
  'no-local-record-guard': noLocalRecordGuard,
  'no-unguarded-outbound-fetch': noUnguardedOutboundFetch,
  'no-unsafe-json-parse-assertion': noUnsafeJsonParseAssertion,
  'no-unvalidated-request-json': noUnvalidatedRequestJson,
};

export default {
  meta: {
    name: '@simple-agent-manager/eslint-plugin-sam',
    version: '0.0.0',
  },
  rules,
};

export { rules };
