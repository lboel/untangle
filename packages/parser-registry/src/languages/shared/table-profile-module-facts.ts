/** Import- und Aufruffakten des Tabellenprofils. */
import type { RawCall, RawImport } from "@untangle-code/domain";

import type { FileTextContext } from "./node-utils.js";
import { rangeOf, unquote } from "./node-utils.js";
import type { ModuleFactSink } from "./profile.js";
import type { SyntaxNode } from "./syntax.js";
import {
  descendantsOfKinds,
  firstChildByKindPriority,
  nameTextsOf,
  setOf,
} from "./table-profile-queries.js";
import type { CallRules, ImportRules } from "./table-profile.js";

interface Callee {
  calleeName: string;
  qualifier?: string;
}

interface ImportParts {
  pathNode: SyntaxNode | null;
  names: string[];
}

/** Kompiliert ausschliesslich Import- und Aufrufregeln einer Sprachtabelle. */
export class TableModuleFactCollector {
  readonly nodeKinds: ReadonlySet<string>;

  private readonly importKinds: ReadonlySet<string>;
  private readonly importSpecKinds: ReadonlySet<string>;
  private readonly callKinds: ReadonlySet<string>;
  private readonly constructionKinds: ReadonlySet<string>;
  private readonly memberKinds: ReadonlySet<string>;
  private readonly functionField: string;
  private readonly argumentsField: string;

  constructor(
    private readonly imports: ImportRules,
    private readonly calls: CallRules,
  ) {
    this.importKinds = setOf(imports.kinds);
    this.importSpecKinds = setOf(imports.specKinds);
    this.callKinds = setOf(calls.kinds);
    this.constructionKinds = setOf(calls.constructionKinds);
    this.memberKinds = setOf(calls.memberKinds);
    this.functionField = calls.functionField ?? "function";
    this.argumentsField = calls.argumentsField ?? "arguments";
    this.nodeKinds = new Set([...this.importKinds, ...this.callKinds, ...this.constructionKinds]);
  }

  collect(
    node: SyntaxNode,
    kind: string,
    callerScopeId: string,
    ctx: FileTextContext,
    sink: ModuleFactSink,
  ): void {
    if (this.importKinds.has(kind)) {
      this.collectImports(node, ctx, sink);
    } else if (this.callKinds.has(kind) || this.constructionKinds.has(kind)) {
      this.collectCall(node, callerScopeId, ctx, sink);
    }
  }

  private collectImports(node: SyntaxNode, ctx: FileTextContext, sink: ModuleFactSink): void {
    const found =
      this.importSpecKinds.size === 0 ? [] : descendantsOfKinds(node, this.importSpecKinds);
    const specs = this.importSpecKinds.size > 0 && found.length > 0 ? found : [node];
    for (const spec of specs) this.collectImportSpec(spec, ctx, sink);
  }

  private collectImportSpec(spec: SyntaxNode, ctx: FileTextContext, sink: ModuleFactSink): void {
    const parts = this.importPartsOf(spec);
    const specifier = unquote((parts.pathNode ?? spec).text.trim());
    if (specifier.length === 0) return;
    const rawImport: RawImport = {
      specifier,
      importKind: "import",
      range: rangeOf(spec, ctx),
      // Ohne echte Namensknoten bleibt die Bindung unbekannt.
      ...(parts.names.length > 0 ? { importedNames: parts.names } : {}),
    };
    sink.imports.push(rawImport);
  }

  private importPartsOf(spec: SyntaxNode): ImportParts {
    let pathNode = this.initialImportPathOf(spec);
    let names =
      this.imports.aliasField === undefined
        ? []
        : nameTextsOf(spec.childForFieldName(this.imports.aliasField));
    for (const rule of this.imports.unwrap ?? []) {
      if (pathNode === null || !rule.kinds.includes(pathNode.type)) continue;
      if (rule.aliasField !== undefined) {
        names = [...names, ...nameTextsOf(pathNode.childForFieldName(rule.aliasField))];
      }
      if (rule.namesField !== undefined) {
        names = [...names, ...this.namedChildTexts(pathNode.childForFieldName(rule.namesField))];
      }
      pathNode = pathNode.childForFieldName(rule.pathField) ?? pathNode;
    }
    return { pathNode, names };
  }

  private initialImportPathOf(spec: SyntaxNode): SyntaxNode | null {
    if (this.imports.pathField !== undefined) {
      const byField = spec.childForFieldName(this.imports.pathField);
      if (byField !== null) return byField;
    }
    return this.imports.pathKinds === undefined
      ? null
      : firstChildByKindPriority(spec, this.imports.pathKinds);
  }

  private namedChildTexts(node: SyntaxNode | null): string[] {
    if (node === null) return [];
    const names: string[] = [];
    for (let index = 0; index < node.namedChildCount; index += 1) {
      const entry = node.namedChild(index);
      if (entry !== null) names.push(entry.text);
    }
    return names;
  }

  private collectCall(
    node: SyntaxNode,
    callerScopeId: string,
    ctx: FileTextContext,
    sink: ModuleFactSink,
  ): void {
    if (this.calls.acceptCall?.(node) === false) return;
    const callee = this.calleeOf(node);
    if (callee === null) return;
    const args = node.childForFieldName(this.argumentsField);
    const call: RawCall = {
      calleeName: callee.calleeName,
      ...(callee.qualifier === undefined ? {} : { qualifier: callee.qualifier }),
      callerScopeId,
      range: rangeOf(node, ctx),
      ...(args === null ? {} : { argumentCount: args.namedChildCount }),
    };
    sink.calls.push(call);
  }

  private calleeOf(node: SyntaxNode): Callee | null {
    const target = this.callTargetOf(node);
    if (target === null) return null;
    const receiver =
      this.calls.receiverField === undefined
        ? null
        : node.childForFieldName(this.calls.receiverField);
    if (receiver !== null && !this.memberKinds.has(target.type)) {
      return { calleeName: target.text, qualifier: receiver.text };
    }
    return this.memberKinds.has(target.type)
      ? this.memberCalleeOf(target)
      : { calleeName: target.text };
  }

  private callTargetOf(node: SyntaxNode): SyntaxNode | null {
    const constructedType =
      this.calls.constructedTypeField === undefined
        ? null
        : node.childForFieldName(this.calls.constructedTypeField);
    return node.childForFieldName(this.functionField) ?? constructedType ?? node.namedChild(0);
  }

  private memberCalleeOf(target: SyntaxNode): Callee {
    const parts = target.children.filter((child) => child.type !== ".");
    const calleeName = (parts.at(-1)?.text ?? target.text).replace(/^[.:]+/, "");
    const qualifier = target.text
      .slice(0, Math.max(0, target.text.length - calleeName.length))
      .replace(/[.:]+$/, "");
    return { calleeName, ...(qualifier.length === 0 ? {} : { qualifier }) };
  }
}
