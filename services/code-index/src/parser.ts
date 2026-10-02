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
    | "function"
    | "class"
    | "method"
    | "interface"
    | "type"
    | "variable";
  startLine: number;
  endLine: number;
  content: string;
  docstring?: string;
  searchableText: string;
}

export interface SymbolCandidate {
  name: string;
  type: CodeSymbolChunk["symbolType"];
  node: Parser.SyntaxNode;
}

export interface LanguageDefinition {
  name: string;
  extensions: string[];
  wasmFile: string;
  extractSymbols?: (node: Parser.SyntaxNode) => SymbolCandidate | null;
}

function extractTsJsSymbols(node: Parser.SyntaxNode): SymbolCandidate | null {
  if (node.type === "function_declaration") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return { name: nameNode.text, type: "function", node };
  } else if (node.type === "class_declaration") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return { name: nameNode.text, type: "class", node };
  } else if (node.type === "method_definition") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return { name: nameNode.text, type: "method", node };
  } else if (node.type === "interface_declaration") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return { name: nameNode.text, type: "interface", node };
  } else if (node.type === "type_alias_declaration") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return { name: nameNode.text, type: "type", node };
  } else if (
    node.type === "lexical_declaration" ||
    node.type === "variable_declaration"
  ) {
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
          return { name: nameNode.text, type: "function", node };
        }
      }
    }
  }
  return null;
}

export class LanguageRegistry {
  private languagesByExt = new Map<string, LanguageDefinition>();
  private loadedLanguages = new Map<string, Parser.Language>();

  constructor() {
    this.registerDefaults();
  }

  public register(def: LanguageDefinition): void {
    for (const ext of def.extensions) {
      const normalized = ext.startsWith(".")
        ? ext.toLowerCase()
        : `.${ext.toLowerCase()}`;
      this.languagesByExt.set(normalized, def);
    }
  }

  public getDefinition(ext: string): LanguageDefinition | undefined {
    const normalized = ext.startsWith(".")
      ? ext.toLowerCase()
      : `.${ext.toLowerCase()}`;
    return this.languagesByExt.get(normalized);
  }

  public isRegistered(ext: string): boolean {
    return this.getDefinition(ext) !== undefined;
  }

  public getRegisteredExtensions(): string[] {
    return Array.from(this.languagesByExt.keys());
  }

  public async getOrLoadLanguage(
    def: LanguageDefinition,
  ): Promise<Parser.Language> {
    const cached = this.loadedLanguages.get(def.name);
    if (cached) return cached;

    let wasmPath = def.wasmFile;
    if (!path.isAbsolute(wasmPath)) {
      try {
        wasmPath = require.resolve(`tree-sitter-wasms/out/${def.wasmFile}`);
      } catch {
        wasmPath = path.resolve(
          process.cwd(),
          `node_modules/tree-sitter-wasms/out/${def.wasmFile}`,
        );
      }
    }

    const lang = await Parser.Language.load(wasmPath);
    this.loadedLanguages.set(def.name, lang);
    return lang;
  }

  private registerDefaults(): void {
    // 1. TypeScript
    this.register({
      name: "typescript",
      extensions: [".ts", ".tsx"],
      wasmFile: "tree-sitter-typescript.wasm",
      extractSymbols: extractTsJsSymbols,
    });

    // 2. JavaScript
    this.register({
      name: "javascript",
      extensions: [".js", ".jsx", ".mjs", ".cjs"],
      wasmFile: "tree-sitter-javascript.wasm",
      extractSymbols: extractTsJsSymbols,
    });

    // 3. Python
    this.register({
      name: "python",
      extensions: [".py"],
      wasmFile: "tree-sitter-python.wasm",
      extractSymbols: (node) => {
        if (node.type === "function_definition") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "function", node };
        } else if (node.type === "class_definition") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "class", node };
        }
        return null;
      },
    });

    // 4. Go
    this.register({
      name: "go",
      extensions: [".go"],
      wasmFile: "tree-sitter-go.wasm",
      extractSymbols: (node) => {
        if (node.type === "function_declaration") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "function", node };
        } else if (node.type === "method_declaration") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "method", node };
        } else if (node.type === "type_declaration") {
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child?.type === "type_spec") {
              const name = child.childForFieldName("name")?.text;
              if (name) return { name, type: "type", node };
            }
          }
        }
        return null;
      },
    });

    // 5. Ruby
    this.register({
      name: "ruby",
      extensions: [".rb"],
      wasmFile: "tree-sitter-ruby.wasm",
      extractSymbols: (node) => {
        if (node.type === "method" || node.type === "singleton_method") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "method", node };
        } else if (node.type === "class" || node.type === "module") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "class", node };
        }
        return null;
      },
    });

    // 6. Java
    this.register({
      name: "java",
      extensions: [".java"],
      wasmFile: "tree-sitter-java.wasm",
      extractSymbols: (node) => {
        if (node.type === "method_declaration") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "method", node };
        } else if (node.type === "class_declaration") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "class", node };
        } else if (node.type === "interface_declaration") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "interface", node };
        }
        return null;
      },
    });

    // 7. Rust
    this.register({
      name: "rust",
      extensions: [".rs"],
      wasmFile: "tree-sitter-rust.wasm",
      extractSymbols: (node) => {
        if (node.type === "function_item") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "function", node };
        } else if (node.type === "struct_item") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "class", node };
        } else if (node.type === "enum_item") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "type", node };
        } else if (node.type === "trait_item") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "interface", node };
        }
        return null;
      },
    });

    // 8. C#
    this.register({
      name: "c_sharp",
      extensions: [".cs"],
      wasmFile: "tree-sitter-c_sharp.wasm",
      extractSymbols: (node) => {
        if (node.type === "method_declaration") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "method", node };
        } else if (node.type === "class_declaration") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "class", node };
        } else if (node.type === "interface_declaration") {
          const name = node.childForFieldName("name")?.text;
          if (name) return { name, type: "interface", node };
        }
        return null;
      },
    });
  }
}

export class TreeSitterCodeParser {
  private parser: Parser | null = null;
  private registry: LanguageRegistry;
  private initialized = false;

  constructor(registry?: LanguageRegistry) {
    this.registry = registry || new LanguageRegistry();
  }

  public getRegistry(): LanguageRegistry {
    return this.registry;
  }

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

    this.parser = new Parser();
    this.initialized = true;
  }

  /**
   * Fallback line-window chunking for files without a registered tree-sitter grammar.
   * Never silently skips files.
   */
  public chunkByLineWindow(
    repo: string,
    filePath: string,
    sourceCode: string,
    windowSize = 50,
    overlap = 10,
  ): CodeSymbolChunk[] {
    const lines = sourceCode.split(/\r?\n/);
    if (lines.length === 0 || sourceCode.trim().length === 0) return [];

    const step = Math.max(1, windowSize - overlap);
    const chunks: CodeSymbolChunk[] = [];
    const baseName = path.basename(filePath);

    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(lines.length, start + windowSize);
      const chunkLines = lines.slice(start, end);
      const content = chunkLines.join("\n");
      const startLine = start + 1;
      const endLine = end;
      const id = `${repo}:${filePath}:chunk:${startLine}-${endLine}`;
      const symbolName = `${baseName}:L${startLine}-L${endLine}`;

      chunks.push({
        id,
        repo,
        filePath,
        symbolName,
        symbolType: "variable",
        startLine,
        endLine,
        content,
        searchableText: `File: ${filePath} (lines ${startLine}-${endLine})\nCode:\n${content}`,
      });

      if (end >= lines.length) break;
    }

    return chunks;
  }

  public async parseSymbols(
    repo: string,
    filePath: string,
    sourceCode: string,
  ): Promise<CodeSymbolChunk[]> {
    if (!this.parser || !this.initialized) {
      throw new Error(
        "TreeSitterCodeParser is not initialized. Call init() first.",
      );
    }

    const ext = path.extname(filePath).toLowerCase();
    const langDef = this.registry.getDefinition(ext);

    // If no registered grammar, fall back to line-window chunking (never silently skipped!)
    if (!langDef) {
      return this.chunkByLineWindow(repo, filePath, sourceCode);
    }

    try {
      const language = await this.registry.getOrLoadLanguage(langDef);
      this.parser.setLanguage(language);

      const tree = this.parser.parse(sourceCode);
      const lines = sourceCode.split(/\r?\n/);
      const chunks: CodeSymbolChunk[] = [];

      const extractor = langDef.extractSymbols || extractTsJsSymbols;
      const extractPrecedingComment = (
        startLine: number,
      ): string | undefined => {
        const commentLines: string[] = [];
        let i = startLine - 2;
        while (i >= 0) {
          const line = lines[i].trim();
          if (
            line.startsWith("//") ||
            line.startsWith("#") ||
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

      const visit = (node: Parser.SyntaxNode) => {
        const candidate = extractor(node);
        if (candidate) {
          const startLine = candidate.node.startPosition.row + 1;
          const endLine = candidate.node.endPosition.row + 1;
          const content = lines.slice(startLine - 1, endLine).join("\n");
          const docstring = extractPrecedingComment(startLine);

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

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child);
        }
      };

      visit(tree.rootNode);

      // If tree-sitter parsed 0 symbols, fall back to line-window chunking
      if (chunks.length === 0 && sourceCode.trim().length > 0) {
        return this.chunkByLineWindow(repo, filePath, sourceCode);
      }

      return chunks;
    } catch {
      // Graceful fallback to line-window chunking
      return this.chunkByLineWindow(repo, filePath, sourceCode);
    }
  }
}
