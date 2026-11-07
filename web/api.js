export function createApi(getCsrf, onUnauthorized = () => {}) {
  return async function api(path, options = {}) {
    const { download, ...requestOptions } = options;
    const headers = { ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.method && options.method !== 'GET' && getCsrf()) {
      headers['x-courseflow-csrf'] = getCsrf();
    }
    const response = await fetch(path, {
      ...requestOptions,
      credentials: 'same-origin',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (download && response.ok) return { blob: await response.blob(), filename: /filename="([\w.-]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'courseflow.log' };
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data?.error?.message || `请求失败（${response.status}）`);
      error.code = data?.error?.code;
      error.status = response.status;
      if (response.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/me') onUnauthorized();
      throw error;
    }
    return data;
  };
}

export const platformPath = (id) => '/api/platforms/' + encodeURIComponent(id);
export const coursePath = (pid, course) => platformPath(pid) + '/courses/' +
  encodeURIComponent(course.id) + '/' + encodeURIComponent(course.recruit_id);
export const courseHref = (pid, course) => '#/platform/' + encodeURIComponent(pid) + '/course/' +
  encodeURIComponent(course.id) + '/' + encodeURIComponent(course.recruit_id);

export function parseRoute(hash) {
  try {
    const parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    if (!parts[0] || parts[0] === 'courses') return { page: 'courses', pid: null };
    if (parts[0] === 'platform' && parts[1]) {
      if (parts[2] === 'course' && parts[3] && parts[4]) {
        return { page: 'course', pid: parts[1], id: parts[3], rid: parts[4], ...(parts[5] ? { tab: parts[5] } : {}) };
      }
      return { page: 'courses', pid: parts[1] };
    }
    if (['tasks', 'connections', 'modules', 'account', 'settings', 'logs', 'invitations', 'login', 'register'].includes(parts[0])) return { page: parts[0] };
  } catch { /* A malformed hash is an unknown page, never a broken application. */ }
  return { page: 'not-found' };
}
