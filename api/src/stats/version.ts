/**
 * Version of the statistics code in api/src/stats (bootstrap, compare, sign test, McNemar, pilot). Stored on comparison_run, and part of
 * its dedupe key, so a bump makes the next compare compute afresh instead of returning a stored result of the old shape.
 * Bump it whenever the compare payload gains, loses or re-means a field. 1.1.0: P6 added `failures` and the per_task failure
 * categories to the payload without a bump, so a stored 1.0.0 result may lack them.
 */
export const STATS_VERSION = '1.1.0';
