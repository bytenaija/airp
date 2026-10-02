import path from "node:path";
import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

export interface CodeSymbolChunk {
  id: string;
  repo: string;
  filePath: string;
  symbolName: string;
  symbolType:
    "function" | "class" | "method" | "interface" | "type" | "variable";
  startLine: number;
  endLine: number;
  content: string;
  docstring?: string;
  searchableText: string;
}

export class TreeSitterCodeParser {
  private parser: Parser | null = null;
  private tsLanguage: Parser.Language | null = null;
  private jsLanguage: Parser.Language | null = null;
  private initialized = false;

  public async init(): Promise<void> {
    if (this.initialized) return;

    let wasmDir: string;
    try {
      wasmDir = path.dirname(require.resolve("web-tree-sitter"));
    } catch {
      wasmDir = path.resolve(process.cwd(), "node_modules/web-tree-sitter");
    }

    await Parser.init({
      locateFile(scriptName: string) {
        return path.join(wasmDir, scriptName);
      },
    });

    const tsWasmPath =
      require.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm");
    const jsWasmPath =
      require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm");

    this.tsLanguage = await Parser.Language.load(tsWasmPath);
    this.jsLanguage = await Parser.Language.load(jsWasmPath);

    this.parser = new Parser();
    this.initialized = true;
  }

  public parseSymbols(
    repo: string,
    filePath: string,
    sourceCode: string,
  ): CodeSymbolChunk[] {
    if (!this.parser || !this.tsLanguage || !this.jsLanguage) {
      throw new Error(
        "TreeSitterCodeParser is not initialized. Call init() first.",
      );
    }

    const isTs = filePath.endsWith(".ts") || filePath.endsWith(".tsx");
    this.parser.setLanguage(isTs ? this.tsLanguage : this.jsLanguage);

    const tree = this.parser.parse(sourceCode);
    const lines = sourceCode.split(/\r?\n/);
    const chunks: CodeSymbolChunk[] = [];

    // Helper to find preceding docstrings/comments
    const extractPrecedingComment = (startLine: number): string | undefined => {
      const commentLines: string[] = [];
      let i = startLine - 2; // startLine is 1-based, line index is 0-based
      while (i >= 0) {
        const line = lines[i].trim();
        if (
          line.startsWith("//") ||
          line.startsWith("*") ||
          line.startsWith("/*") ||
          line.endsWith("*/")
        ) {
          commentLines.unshift(line);
          i--;
        } else {
          break;
        }
      }
      return commentLines.length > 0 ? commentLines.join("\n") : undefined;
    };

    // Traverse AST looking for symbols
    const visit = (node: Parser.SyntaxNode) => {
      let candidate: {
        name: string;
        type: CodeSymbolChunk["symbolType"];
        node: Parser.SyntaxNode;
      } | null = null;

      if (node.type === "function_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          candidate = { name: nameNode.text, type: "function", node };
        }
      } else if (node.type === "class_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          candidate = { name: nameNode.text, type: "class", node };
        }
      } else if (node.type === "method_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          candidate = { name: nameNode.text, type: "method", node };
        }
      } else if (node.type === "interface_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          candidate = { name: nameNode.text, type: "interface", node };
        }
      } else if (node.type === "type_alias_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          candidate = { name: nameNode.text, type: "type", node };
        }
      } else if (
        node.type === "lexical_declaration" ||
        node.type === "variable_declaration"
      ) {
        // Look for const foo = () => ... or const foo = function() ...
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i);
          if (declarator?.type === "variable_declarator") {
            const nameNode = declarator.childForFieldName("name");
            const valueNode = declarator.childForFieldName("value");
            if (
              nameNode &&
              valueNode &&
              (valueNode.type === "arrow_function" ||
                valueNode.type === "function")
            ) {
              candidate = { name: nameNode.text, type: "function", node };
              break;
            }
          }
        }
      }

      if (candidate) {
        const startLine = candidate.node.startPosition.row + 1;
        const endLine = candidate.node.endPosition.row + 1;
        const content = lines.slice(startLine - 1, endLine).join("\n");
        const docstring = extractPrecedingComment(startLine);

        // Searchable text combines docstring, name, file path, and code body
        const searchableParts = [
          `File: ${filePath}`,
          `Symbol: ${candidate.name} (${candidate.type})`,
        ];
        if (docstring) searchableParts.push(`Doc: ${docstring}`);
        searchableParts.push(`Code:\n${content}`);
        const searchableText = searchableParts.join("\n");

        const id = `${repo}:${filePath}:${candidate.name}:${startLine}`;
        chunks.push({
          id,
          repo,
          filePath,
          symbolName: candidate.name,
          symbolType: candidate.type,
          startLine,
          endLine,
          content,
          docstring,
          searchableText,
        });
      }

      // Recurse into children
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visit(child);
      }
    };

    visit(tree.rootNode);

    // If file has no symbols, index whole file if non-empty
    if (
      chunks.length === 0 &&
      lines.length > 0 &&
      sourceCode.trim().length > 0
    ) {
      const fileName = path.basename(filePath);
      const content = sourceCode;
      chunks.push({
        id: `${repo}:${filePath}:file:1`,
        repo,
        filePath,
        symbolName: fileName,
        symbolType: "variable",
        startLine: 1,
        endLine: lines.length,
        content,
        searchableText: `File: ${filePath}\nCode:\n${content}`,
      });
    }

    return chunks;
  }
}
