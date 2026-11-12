import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface FailureSnapshot {
    charterName: string;
    iteration: number;
    seed: number;
    error: string;
    flowName: string;
    executionTrace: any[];
    topologyMetadata?: any;
    timestamp: string;
}

export class FailureShrinker {
    static async captureAndSaveFailure(outputDir: string, snapshot: FailureSnapshot): Promise<string> {
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const fileName = `failure_${snapshot.charterName}_seed${snapshot.seed}_iter${snapshot.iteration}_${Date.now()}_${randomUUID().slice(0, 8)}.json`;
        const filePath = path.join(outputDir, fileName);

        fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), { encoding: 'utf-8', flag: 'wx' });
        return filePath;
    }

    /**
     * Attempts to find the minimal failing slice of executed steps
     */
    static minimizeTrace(trace: any[], predicate: (subTrace: any[]) => boolean): any[] {
        let current = [...trace];
        let stepSize = Math.floor(current.length / 2);

        while (stepSize > 0) {
            let reduced = false;
            for (let i = 0; i < current.length; i += stepSize) {
                const candidate = [...current.slice(0, i), ...current.slice(i + stepSize)];
                if (candidate.length > 0 && predicate(candidate)) {
                    current = candidate;
                    reduced = true;
                    break;
                }
            }
            if (!reduced) {
                stepSize = Math.floor(stepSize / 2);
            }
        }
        return current;
    }
}
