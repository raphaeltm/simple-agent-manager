async (page) => {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) return 'ERROR: SAM_PLAYWRIGHT_PRIMARY_USER not set';

  const resp = await page.request.post('https://api.sammy.party/api/auth/token-login', {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await resp.json();

  // Navigate to app after login (cookie should be set by the POST)
  await page.goto('https://app.sammy.party');
  await page.waitForTimeout(2000);

  return { status: resp.status(), body, url: page.url() };
}
