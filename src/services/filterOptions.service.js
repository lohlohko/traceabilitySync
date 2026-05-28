const { pgPool } = require('../config/postgres');

const PROCESS_COLUMN_MAP = {
  ma: { line: 'ma_line', datetime: 'ma_datetime' },
  te: { line: 'te_line', datetime: 'te_datetime' },
  al: { line: 'al_line', datetime: 'al_datetime' },
  sa: { line: 'sa_line', datetime: 'sa_datetime' },
  ft: { line: 'ft_line', datetime: 'ft_datetime' },
  as: { line: 'as_line', datetime: 'as_datetime' },
};

const getProcessList = () => {
  return Object.keys(PROCESS_COLUMN_MAP).map((key) => ({
    key,
    label: key.toUpperCase(),
  }));
};

const getLinesByProcess = async (processKey) => {
  const config = PROCESS_COLUMN_MAP[processKey];
  if (!config) {
    return { error: `Invalid process '${processKey}'. Valid options: ${Object.keys(PROCESS_COLUMN_MAP).join(', ')}` };
  }

  const lineColumn = config.line;
  const query = `
    SELECT DISTINCT ${lineColumn} AS line
    FROM traceability_report
    WHERE ${lineColumn} IS NOT NULL
      AND ${lineColumn} <> ''
    ORDER BY ${lineColumn} ASC
  `;

  const result = await pgPool.query(query);
  return { lines: result.rows.map((r) => r.line) };
};

const getYearsByProcess = async (processKey) => {
  const config = PROCESS_COLUMN_MAP[processKey];
  if (!config) {
    return { error: `Invalid process '${processKey}'. Valid options: ${Object.keys(PROCESS_COLUMN_MAP).join(', ')}` };
  }

  const datetimeColumn = config.datetime;
  const query = `
    SELECT DISTINCT EXTRACT(YEAR FROM ${datetimeColumn})::INT AS year
    FROM traceability_report
    WHERE ${datetimeColumn} IS NOT NULL
    ORDER BY year DESC
  `;

  const result = await pgPool.query(query);
  return { years: result.rows.map((r) => r.year) };
};

const getAllFilterOptions = async (processKey) => {
  const processes = getProcessList();
  
  const resolvedProcess = processKey && PROCESS_COLUMN_MAP[processKey]
    ? processKey
    : Object.keys(PROCESS_COLUMN_MAP)[0];

  const [linesResult, yearsResult] = await Promise.all([
    getLinesByProcess(resolvedProcess),
    getYearsByProcess(resolvedProcess),
  ]);

  if (linesResult.error) return { error: linesResult.error };
  if (yearsResult.error) return { error: yearsResult.error };

  return {
    processes,
    activeProcess: resolvedProcess,
    lines: linesResult.lines,
    years: yearsResult.years,
  };
};

module.exports = {
  PROCESS_COLUMN_MAP,
  getProcessList,
  getLinesByProcess,
  getYearsByProcess,
  getAllFilterOptions,
};
