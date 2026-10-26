/**
 * ABAP Unit as a debugger trigger: run an object's HARMLESS tests (`/sap/bc/adt/abapunit/testruns`)
 * and summarize the outcome. Ported from ARC-1 (src/adt/devtools.ts `runUnitTests`, src/adt/aunit.ts
 * `parseAunitRunResult`), keeping only the summary a capture reports.
 */

import type { AdtHttpClient, AdtRequestOptions } from './http.js';
import { asNode, asNodes, attr, escapeXml, parseXml, text, type XmlNode } from './xml.js';

export type AunitOutcome = 'passed' | 'failed' | 'no_tests' | 'incomplete';

export interface AunitSummary {
  tests: number;
  passed: number;
  failures: number;
  errors: number;
  skipped: number;
  warnings: number;
}

export interface AunitRunResult {
  outcome: AunitOutcome;
  summary: AunitSummary;
}

interface Alert {
  scope: 'run' | 'program' | 'class' | 'method';
  kind: string;
  severity: string;
  message: string;
}

/** Harmless risk level only: a debugger trigger never runs dangerous or critical tests. */
export function buildRunConfiguration(objectUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">
  <external>
    <coverage active="false"/>
  </external>
  <options>
    <uriType value="semantic"/>
    <testDeterminationStrategy sameProgram="true" assignedTests="false" publicApi="false"/>
    <testRiskLevels harmless="true" dangerous="false" critical="false"/>
    <testDurations short="true" medium="true" long="true"/>
  </options>
  <adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core">
    <objectSet kind="inclusive">
      <adtcore:objectReferences>
        <adtcore:objectReference adtcore:uri="${escapeXml(objectUrl)}"/>
      </adtcore:objectReferences>
    </objectSet>
  </adtcore:objectSets>
</aunit:runConfiguration>`;
}

function children(node: XmlNode | undefined, parent: string, child: string): XmlNode[] {
  return asNodes(asNode(node?.[parent])?.[child]);
}

function details(node: XmlNode): string[] {
  return children(node, 'details', 'detail').flatMap((detail) => [attr(detail, 'text').trim(), ...details(detail)]);
}

function parseAlert(node: XmlNode, scope: Alert['scope']): Alert {
  return {
    scope,
    kind: attr(node, 'kind'),
    severity: attr(node, 'severity'),
    message: [text(node.title).trim(), ...details(node)].filter(Boolean).join(' — '),
  };
}

const isWarning = (alert: Alert): boolean =>
  alert.kind.toLowerCase() === 'warning' || alert.severity.toLowerCase() === 'tolerable';

const isRiskRefusal = (alert: Alert): boolean =>
  /risk level.+exceeds|upper limit.+risk|no execution.+risk/i.test(alert.message);

function isInfrastructureError(alert: Alert): boolean {
  const kind = alert.kind.toLowerCase();
  if (kind === 'failedassertion') return alert.scope !== 'method';
  if (['exception', 'error', 'fatal', 'generationerror'].includes(kind)) return true;
  return alert.severity.toLowerCase() === 'critical' && !isWarning(alert);
}

function methodStatus(alerts: Alert[]): 'passed' | 'failed' | 'error' | 'skipped' {
  if (alerts.some((alert) => alert.kind.toLowerCase() === 'failedassertion')) return 'failed';
  if (alerts.some((alert) => isRiskRefusal(alert) || /skip|abortion|not executed/i.test(alert.kind))) return 'skipped';
  if (alerts.some(isInfrastructureError)) return 'error';
  return 'passed';
}

/** The run's counts and outcome; anything that leaves the run unproven reads `incomplete`, never `passed`. */
export function parseAunitRunResult(xml: string): AunitRunResult {
  const run = asNode(parseXml(xml).runResult);
  const alerts: Alert[] = children(run, 'alerts', 'alert').map((alert) => parseAlert(alert, 'run'));
  const statuses: string[] = [];
  let incompleteEvidence = false;
  for (const program of asNodes(run?.program)) {
    alerts.push(...children(program, 'alerts', 'alert').map((alert) => parseAlert(alert, 'program')));
    for (const testClass of children(program, 'testClasses', 'testClass')) {
      const classAlerts = children(testClass, 'alerts', 'alert').map((alert) => parseAlert(alert, 'class'));
      alerts.push(...classAlerts);
      const methods = children(testClass, 'testMethods', 'testMethod');
      // A class that ran nothing (or above the harmless level) cannot prove the run complete.
      const risk = attr(testClass, 'riskLevel').toLowerCase();
      if ((methods.length === 0 && !classAlerts.some(isInfrastructureError)) || (risk && risk !== 'harmless')) {
        incompleteEvidence = true;
      }
      for (const method of methods) {
        const methodAlerts = children(method, 'alerts', 'alert').map((alert) => parseAlert(alert, 'method'));
        alerts.push(...methodAlerts);
        statuses.push(methodStatus(methodAlerts));
      }
    }
  }
  const count = (status: string) => statuses.filter((candidate) => candidate === status).length;
  const summary: AunitSummary = {
    tests: statuses.length,
    passed: count('passed'),
    failures: count('failed'),
    errors: count('error') + alerts.filter((alert) => alert.scope !== 'method' && isInfrastructureError(alert)).length,
    skipped: count('skipped'),
    warnings: alerts.filter(isWarning).length,
  };
  incompleteEvidence ||= alerts.some(
    (alert) => isRiskRefusal(alert) || /not executed|abortion|skip/i.test(alert.message),
  );
  let outcome: AunitOutcome;
  if (summary.failures > 0 || summary.errors > 0) outcome = 'failed';
  else if (summary.tests === 0) outcome = alerts.length === 0 && !incompleteEvidence ? 'no_tests' : 'incomplete';
  else if (summary.skipped === summary.tests || incompleteEvidence) outcome = 'incomplete';
  else outcome = 'passed';
  return { outcome, summary };
}

/** Run the harmless unit tests of one object (`/sap/bc/adt/oo/classes/ZCL_X`, a program or a function group). */
export async function runUnitTests(
  http: AdtHttpClient,
  objectUrl: string,
  options?: AdtRequestOptions,
): Promise<AunitRunResult> {
  const resp = await http.post(
    '/sap/bc/adt/abapunit/testruns',
    buildRunConfiguration(objectUrl),
    'application/vnd.sap.adt.abapunit.testruns.config.v4+xml',
    { Accept: 'application/vnd.sap.adt.abapunit.testruns.result.v2+xml' },
    options,
  );
  return parseAunitRunResult(resp.body);
}
