import { readFileSync } from 'node:fs';
import {
    investigateTelemetry,
    offlineInvestigationRecording,
    offlineInvestigationTarget,
} from './workflow/usecases/usecase-25-offline-telemetry-investigation';

// Optional argument: a local telemetry JSON file. Only sanitized, matched inspections are printed.
try {
    const raw = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : offlineInvestigationRecording;
    const report = investigateTelemetry(raw, offlineInvestigationTarget);
    console.log(JSON.stringify(report, null, 2));
    if (!report.accepted) process.exitCode = 1;
} catch {
    console.error('Could not read a valid telemetry JSON recording.');
    process.exitCode = 1;
}
