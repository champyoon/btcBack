const PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
export async function sign(accessKey, secretKey, now = new Date()) {
  const signedDate = now.toISOString().replace(/[-:]/g, '').slice(2, 15) + 'Z';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(signedDate + 'POST' + PATH));
  const signature = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}
