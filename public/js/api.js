// JSON API client. Errors arrive as { ok:false, error:{code,message,details} }.

export async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) { /* non-json */ }
  if (!res.ok || (json && json.ok === false)) {
    const err = new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
    err.code = json && json.error ? json.error.code : 'FORGE_HTTP';
    err.details = json && json.error ? json.error.details : null;
    err.status = res.status;
    throw err;
  }
  return json ? json.data : null;
}

export const get = (p) => call('GET', p);
export const post = (p, b) => call('POST', p, b === undefined ? {} : b);
export const put = (p, b) => call('PUT', p, b);
export const del = (p) => call('DELETE', p);
