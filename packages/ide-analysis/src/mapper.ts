import type { SourceFile, Node as TsNode } from 'typescript';
import type { SourcePosition, SourceRange } from '@siglo/ide-protocol';

/**
 * Normalizes file URIs and file system paths to standard POSIX-like file:// URI or normalized path.
 */
export function normalizeUri(pathOrUri: string): string {
  if (!pathOrUri) return '';
  let normalized = pathOrUri.replace(/\\/g, '/');
  if (normalized.startsWith('file://')) {
    // Decode URI components
    try {
      normalized = decodeURI(normalized);
    } catch {
      // ignore
    }
    return normalized;
  }
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  return `file://${normalized}`;
}

export function toFilePath(pathOrUri: string): string {
  if (!pathOrUri) return '';
  let path = pathOrUri;
  if (path.startsWith('file://')) {
    path = path.slice(7);
  }
  // Windows file:///C:/path -> C:/path
  if (/^\/[a-zA-Z]:/.test(path)) {
    path = path.slice(1);
  }
  return path.replace(/\\/g, '/');
}

export function getSourcePosition(sourceFile: SourceFile, position: number): SourcePosition {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return { line, character };
}

export function getSourceRange(sourceFile: SourceFile, node: TsNode): SourceRange {
  const startPos = node.getStart(sourceFile);
  const endPos = node.getEnd();
  return {
    start: getSourcePosition(sourceFile, startPos),
    end: getSourcePosition(sourceFile, endPos),
  };
}

export function isPositionInRange(pos: SourcePosition, range: SourceRange): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) {
    return false;
  }
  if (pos.line === range.start.line && pos.character < range.start.character) {
    return false;
  }
  if (pos.line === range.end.line && pos.character > range.end.character) {
    return false;
  }
  return true;
}

export function generateDeterministicNodeId(stepName: string, range: SourceRange): string {
  const cleanName = stepName.replace(/[^a-zA-Z0-9_]/g, '_') || 'anonymous';
  return `step_${cleanName}_L${range.start.line + 1}_C${range.start.character + 1}`;
}
