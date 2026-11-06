/**
 * Tool registry: registration, dual-track naming (canonical dotted / wire underscore),
 * user enable/disable overrides, risk grouping, and provider payload projection.
 * Wire-name uniqueness is enforced at registration (first-come, suffixed later).
 */

import { assertCanonicalName, buildReverseIndex, sanitizeToolName, uniquifyWireNames } from '../../utils/tool-name.js';
import type {
  RiskVerdict,
  ToolDefinition,
  ToolDefinitionPublic,
  ToolEnableContext,
} from '../../types/tool.js';

export interface ProviderToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolListFilter {
  source?: 'builtin' | 'mcp';
  risk?: 'low' | 'medium' | 'high';
  category?: 'http' | 'file' | 'compute' | 'mcp';
}

export class ToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>();
  private reverseIndex = new Map<string, string>();
  private readonly userEnabled = new Map<string, boolean>();

  register(def: ToolDefinition, opts: { overwrite?: boolean } = {}): void {
    assertCanonicalName(def.name);
    if (this.defs.has(def.name) && !opts.overwrite) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    if (this.defs.has(def.name) && opts.overwrite) {
      this.userEnabled.delete(def.name);
    }
    this.defs.set(def.name, def);
    this.rebuildIndex();
  }

  registerAll(defs: readonly ToolDefinition[]): void {
    // Uniquify wire names across the batch before registering (conflicts get _2/_3).
    const wireNames = uniquifyWireNames(defs.map((def) => def.name));
    for (const def of defs) {
      this.register({ ...def, wireName: wireNames.get(def.name)! });
    }
  }

  private rebuildIndex(): void {
    this.reverseIndex = buildReverseIndex([...this.defs.values()]);
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  getByWireName(wire: string): ToolDefinition | undefined {
    const canonical = this.reverseIndex.get(wire.trim().toLowerCase());
    return canonical ? this.defs.get(canonical) : undefined;
  }

  list(filter?: ToolListFilter): ToolDefinition[] {
    let items = [...this.defs.values()];
    if (filter?.source) items = items.filter((def) => def.source === filter.source);
    if (filter?.risk) items = items.filter((def) => def.risk === filter.risk);
    if (filter?.category) items = items.filter((def) => def.category === filter.category);
    return items;
  }

  /** Effective enablement: definition-level predicate AND user override. */
  isEnabled(def: ToolDefinition, ctx: ToolEnableContext): boolean {
    const override = this.userEnabled.get(def.name);
    if (override === false) return false;
    return def.enabled(ctx);
  }

  setEnabled(name: string, enabled: boolean): void {
    this.userEnabled.set(name, enabled);
  }

  groupedByRisk(ctx: ToolEnableContext): Record<'low' | 'medium' | 'high', ToolDefinition[]> {
    const grouped: Record<'low' | 'medium' | 'high', ToolDefinition[]> = { low: [], medium: [], high: [] };
    for (const def of this.list()) {
      if (!this.isEnabled(def, ctx)) continue;
      grouped[def.risk].push(def);
    }
    return grouped;
  }

  /** Projection for GET /api/v1/tools: never contains the handler. */
  listPublic(ctx: ToolEnableContext, filter?: ToolListFilter): ToolDefinitionPublic[] {
    return this.list(filter).map((def) => ({
      name: def.name,
      wireName: def.wireName,
      displayName: def.displayName,
      category: def.category,
      description: def.description,
      inputSchema: def.inputSchema,
      risk: def.risk,
      approvalMode: def.approvalMode,
      enabled: this.isEnabled(def, ctx),
      source: def.source,
      timeoutMs: def.timeoutMs,
      mcpServerId: def.mcpServerId ?? null,
    }));
  }

  /** Tools advertised to the LLM — wire names only, enabled tools only (AC-12). */
  toProviderTools(names?: string[], ctx?: ToolEnableContext): ProviderToolSpec[] {
    const enableCtx: ToolEnableContext = ctx ?? { sandboxRoot: '', mcpConnected: false };
    const defs = names ? names.map((name) => this.defs.get(name)).filter((def): def is ToolDefinition => def !== undefined) : this.list();
    return defs
      .filter((def) => this.isEnabled(def, enableCtx))
      .map((def) => ({
        type: 'function' as const,
        function: {
          name: def.wireName,
          description: def.description,
          parameters: def.inputSchema as unknown as Record<string, unknown>,
        },
      }));
  }

  /** Removing a server's tools must make them invisible to the model immediately. */
  unregisterByMcpServer(serverId: string): number {
    let removed = 0;
    for (const [name, def] of [...this.defs.entries()]) {
      if (def.source === 'mcp' && def.mcpServerId === serverId) {
        this.defs.delete(name);
        this.userEnabled.delete(name);
        removed += 1;
      }
    }
    if (removed > 0) this.rebuildIndex();
    return removed;
  }

  /** Risk grouping for the settings page (ignores enablement; shows everything). */
  groupedByRiskAll(): Record<'low' | 'medium' | 'high', ToolDefinition[]> {
    const grouped: Record<'low' | 'medium' | 'high', ToolDefinition[]> = { low: [], medium: [], high: [] };
    for (const def of this.list()) grouped[def.risk].push(def);
    return grouped;
  }

  /** Canonical names of every registered tool (used in TOOL_NOT_FOUND feedback). */
  canonicalNames(): string[] {
    return [...this.defs.keys()];
  }
}

export { sanitizeToolName };
