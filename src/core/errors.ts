export class AppError extends Error {
  status: number;
  code: string;
  data: unknown;

  constructor(status: number, code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export const badRequest = (message: string, code = 'invalid_request'): AppError =>
  new AppError(400, code, message);
export const unauthorized = (message = '请先登录'): AppError =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = '没有权限'): AppError => new AppError(403, 'forbidden', message);
export const notFound = (message = '找不到请求的资源'): AppError =>
  new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string): AppError => new AppError(409, code, message);
export const badGateway = (code: string, message: string): AppError => new AppError(502, code, message);
export const unavailable = (message = '服务暂不可用'): AppError =>
  new AppError(503, 'unavailable', message);

/**
 * Module error codes are stable strings (spec §6). The framework maps them to HTTP status and
 * passes the code through unchanged so API clients can branch on it.
 */
const MODULE_STATUS: Record<string, number> = {
  unsupported_operation: 501,
  invalid_params: 400,
  platform_login_expired: 409,
  platform_verification_required: 409,
  platform_protocol_changed: 502,
  platform_rejected: 502,
  platform_unavailable: 502,
  not_found: 404,
  module_timeout: 504,
  module_crashed: 502,
  module_unavailable: 503,
  module_version_changed: 503,
  net_blocked: 502,
  quiet_hours: 409,
  session_expired: 409,
};

export type ModuleErrorShape = { code?: unknown; message?: unknown; data?: unknown };

export function fromModuleError(error: ModuleErrorShape): AppError {
  const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : 'module_error';
  const message =
    typeof error.message === 'string' && error.message.length > 0 ? error.message : '模块调用失败';
  return new AppError(MODULE_STATUS[code] ?? 502, code, message, error.data);
}
