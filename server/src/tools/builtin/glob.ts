/** Shared glob matcher used by fs.read, code.search, and fs.glob. */

const WILDCARD_DOUBLE_STAR = '::DOUBLE_STAR::';

/**
 * Convert a glob pattern to a RegExp.
 * - `*` matches any characters except path separators
 * - `**` matches any characters including path separators (any depth)
 * - `?` matches exactly one character except path separators
 * - All other regex metacharacters are escaped
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, WILDCARD_DOUBLE_STAR)
    .replace(/\*/g, '[^/\\\\]*')
    .replace(new RegExp(WILDCARD_DOUBLE_STAR, 'g'), '.*')
    .replace(/\?/g, '[^/\\\\]');
  return new RegExp(`^${escaped}$`);
}