const { pgPool } = require('../config/postgres');

const PROCESS_COLUMN_MAP = {
  ma: { line: 'ma_line', datetime: 'ma_datetime' },
  te: { line: 'te_line', datetime: 'te_datetime' },
  al: { line: 'al_line', datetime: 'al_datetime' },
  sa: { line: 'sa_line', datetime: 'sa_datetime' },
  ft: { line: 'ft_line', datetime: 'ft_datetime' },
  as: { line: 'as_line', datetime: 'as_datetime' }
};

const DEFAULT_PROCESS = 'ma';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 500;

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const buildFilters = (filters) => {
  const where = [];
  const values = [];

  const processKey = filters.process || DEFAULT_PROCESS;
  const processConfig = PROCESS_COLUMN_MAP[processKey];
  if (!processConfig) {
    return { error: `Invalid process '${filters.process}'` };
  }

  if (filters.mcid) {
    values.push(filters.mcid);
    where.push(`mcid = $${values.length}`);
  }

  if (filters.line && processConfig.line) {
    values.push(filters.line);
    where.push(`${processConfig.line} = $${values.length}`);
  }

  if (filters.year && processConfig.datetime) {
    values.push(filters.year);
    where.push(`EXTRACT(YEAR FROM ${processConfig.datetime}) = $${values.length}`);
  }

  if (filters.dateFrom && processConfig.datetime) {
    values.push(filters.dateFrom);
    where.push(`${processConfig.datetime} >= $${values.length}`);
  }

  if (filters.dateTo && processConfig.datetime) {
    values.push(filters.dateTo);
    where.push(`${processConfig.datetime} <= $${values.length}`);
  }

  return { where, values, processConfig, processKey };
};

const fetchTraceability = async (filters) => {
  const limit = Math.min(parseNumber(filters.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const page = Math.max(parseNumber(filters.page, 1), 1);
  const offset = (page - 1) * limit;

  const { where, values, processConfig, processKey, error } = buildFilters(filters);
  if (error) {
    return { error };
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy = processConfig.datetime
    ? `ORDER BY ${processConfig.datetime} DESC NULLS LAST, mcid DESC`
    : 'ORDER BY mcid DESC';

  const countQuery = `SELECT COUNT(*) AS total FROM traceability_report ${whereSql}`;
  const dataQuery = `
    SELECT *
    FROM traceability_report
    ${whereSql}
    ${orderBy}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const countResult = await pgPool.query(countQuery, values);
  const total = Number.parseInt(countResult.rows[0]?.total || '0', 10);

  const dataResult = await pgPool.query(dataQuery, [...values, limit, offset]);

  return {
    items: dataResult.rows,
    meta: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / limit),
      process: processKey
    }
  };
};

module.exports = {
  fetchTraceability,
  PROCESS_COLUMN_MAP
};
