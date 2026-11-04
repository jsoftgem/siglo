import { expect } from 'chai';
import crypto from 'node:crypto';
import { timingSafeCompare } from '../src/webhooks/timing';

describe('Timing Safety (Constant-Time Comparison)', () => {
  it('returns true for identical hex strings', () => {
    const hash = crypto.createHash('sha256').update('test-payload').digest('hex');
    expect(timingSafeCompare(hash, hash, 'hex')).to.be.true;
  });

  it('returns true for identical base64 strings', () => {
    const hash = crypto.createHash('sha256').update('test-payload').digest('base64');
    expect(timingSafeCompare(hash, hash, 'base64')).to.be.true;
  });

  it('returns true for identical Buffer instances', () => {
    const bufA = Buffer.from('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', 'hex');
    const bufB = Buffer.from('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', 'hex');
    expect(timingSafeCompare(bufA, bufB)).to.be.true;
  });

  it('returns false for strings of different lengths without throwing', () => {
    const a = 'abcdef';
    const b = 'abcde';
    expect(timingSafeCompare(a, b, 'utf8')).to.be.false;
  });

  it('returns false when identical length but 1 bit / byte differs', () => {
    const a = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
    // Alter last character '5' -> '6'
    const b = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b946';
    expect(timingSafeCompare(a, b, 'hex')).to.be.false;
  });

  it('returns false on empty strings or buffers', () => {
    expect(timingSafeCompare('', '', 'hex')).to.be.false;
    expect(timingSafeCompare(Buffer.alloc(0), Buffer.alloc(0))).to.be.false;
  });

  it('handles invalid encoding gracefully without crashing', () => {
    // Non-hex strings with hex encoding should not crash
    expect(timingSafeCompare('not_hex_!', 'not_hex_?', 'hex')).to.be.false;
  });
});
