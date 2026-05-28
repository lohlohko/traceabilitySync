const sendResponse = (res, statusCode, status, message, data = null, errors = null) => {
  const payload = { status, statusCode, message };
  if (data !== null) payload.data = data;
  if (errors !== null) payload.errors = errors;
  return res.status(statusCode).json(payload);
};

const ok = (res, message = 'Success', data = null) =>
  sendResponse(res, 200, 'success', message, data);

const created = (res, message = 'Resource created successfully', data = null) =>
  sendResponse(res, 201, 'success', message, data);

const noContent = (res) =>
  res.status(204).send();

const badRequest = (res, message = 'Bad request', errors = null) =>
  sendResponse(res, 400, 'fail', message, null, errors);

const unauthorized = (res, message = 'Unauthorized') =>
  sendResponse(res, 401, 'fail', message);

const forbidden = (res, message = 'Forbidden') =>
  sendResponse(res, 403, 'fail', message);

const notFound = (res, message = 'Resource not found') =>
  sendResponse(res, 404, 'fail', message);

const conflict = (res, message = 'Conflict') =>
  sendResponse(res, 409, 'fail', message);

const unprocessable = (res, message = 'Unprocessable entity', errors = null) =>
  sendResponse(res, 422, 'fail', message, null, errors);

const tooManyRequests = (res, message = 'Too many requests, please try again later') =>
  sendResponse(res, 429, 'fail', message);

const serverError = (res, message = 'Internal server error') =>
  sendResponse(res, 500, 'error', message);

const paginated = (res, message = 'Success', data = [], meta = {}) =>
  sendResponse(res, 200, 'success', message, { items: data, meta });

module.exports = {
  ok,
  created,
  noContent,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  serverError,
  paginated
};
