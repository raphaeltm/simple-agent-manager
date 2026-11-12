import { describe, expect, it } from 'vitest';

import { inboundMailEnabled, inboundMailWorkerVars } from './inbound-mail-settings.js';
import { smtpWorkerVars } from './mail-settings.js';

describe('inbound agent email settings', () => {
  it('is off unless the mail-in profile is on', () => {
    const box = { COMPOSE_PROFILES: 'tunnel,gce' };
    expect(inboundMailEnabled(box)).toBe(false);
    expect(inboundMailWorkerVars(box, {})).toEqual({});
  });

  it('turns agent email on with the mail collector as the reply transport', () => {
    const box = { COMPOSE_PROFILES: 'tunnel, mail-in ,mail-collector' };
    const smtp = smtpWorkerVars(box, {}, 'box.example');
    expect(inboundMailWorkerVars(box, smtp)).toEqual({ AGENT_EMAIL_INBOUND_SMTP: 'true' });
  });

  it('turns agent email on with a real relay', () => {
    const box = {
      COMPOSE_PROFILES: 'mail-in',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USERNAME: 'sam',
      SMTP_FROM: 'sam@box.example',
    };
    const smtp = smtpWorkerVars(box, { SMTP_PASSWORD: 'pw' }, 'box.example');
    expect(inboundMailWorkerVars(box, smtp)).toEqual({ AGENT_EMAIL_INBOUND_SMTP: 'true' });
  });

  it('refuses the profile without an SMTP transport for replies', () => {
    const box = { COMPOSE_PROFILES: 'mail-in' };
    expect(() => inboundMailWorkerVars(box, smtpWorkerVars(box, {}, 'box.example'))).toThrow(
      /needs an SMTP relay/
    );
  });
});
