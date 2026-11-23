import AppKit

/// What a span of source is, for colouring. Plain text is simply not a token.
enum CodeTokenKind: CaseIterable {
    case comment, string, number, keyword, type, function, attribute, tag, meta, heading, addition, deletion
}

struct CodeToken: Equatable {
    let range: NSRange
    let kind: CodeTokenKind
}

/// Languages the preview colours. A file whose language is unknown is still
/// shown, as plain text; detection only decides whether it gets colours.
enum CodeLanguage: String, CaseIterable {
    case c, cpp, objectiveC, csharp, java, kotlin, scala, groovy, swift, go, rust, javascript, typescript, dart, php
    case zig, solidity, shader, protobuf, graphql
    case python, ruby, shell, powershell, perl, r, elixir, julia
    case yaml, toml, ini, dockerfile, makefile, cmake, terraform, nix
    case sql, lua, haskell, erlang, latex, lisp
    case html, xml, vue, css, scss, json, markdown, diff

    var title: String {
        switch self {
        case .cpp: return "C++"
        case .objectiveC: return "Objective-C"
        case .csharp: return "C#"
        case .javascript: return "JavaScript"
        case .typescript: return "TypeScript"
        case .php: return "PHP"
        case .graphql: return "GraphQL"
        case .shader: return "Shader"
        case .powershell: return "PowerShell"
        case .yaml: return "YAML"
        case .toml: return "TOML"
        case .ini: return "INI"
        case .cmake: return "CMake"
        case .sql: return "SQL"
        case .latex: return "LaTeX"
        case .html: return "HTML"
        case .xml: return "XML"
        case .css: return "CSS"
        case .scss: return "SCSS"
        case .json: return "JSON"
        case .r: return "R"
        default: return rawValue.prefix(1).uppercased() + rawValue.dropFirst()
        }
    }

    /// By file name first (Dockerfile, Makefile, dotfiles), then extension,
    /// then the shebang or XML/HTML prologue on the first line.
    static func detect(fileName: String, firstLine: String? = nil) -> CodeLanguage? {
        let name = (fileName as NSString).lastPathComponent.lowercased()
        if let language = byName[name] { return language }
        if name.hasPrefix("dockerfile") || name.hasSuffix(".dockerfile") { return .dockerfile }
        if name.hasPrefix(".") && name.hasSuffix("ignore") { return .ini }
        if name.hasSuffix(".blade.php") { return .php }
        let ext = (name as NSString).pathExtension
        if !ext.isEmpty, let language = byExtension[ext] { return language }
        guard let line = firstLine?.trimmingCharacters(in: .whitespaces).lowercased(), !line.isEmpty else { return nil }
        if line.hasPrefix("#!") {
            if line.contains("python") { return .python }
            if line.contains("node") || line.contains("deno") || line.contains("bun") { return .javascript }
            if line.contains("ruby") { return .ruby }
            if line.contains("perl") { return .perl }
            if line.contains("php") { return .php }
            if line.contains("lua") { return .lua }
            if line.contains("pwsh") { return .powershell }
            if line.contains("sh") { return .shell }
            return nil
        }
        if line.hasPrefix("<?xml") { return .xml }
        if line.hasPrefix("<!doctype html") || line.hasPrefix("<html") { return .html }
        return nil
    }

    private static let byName: [String: CodeLanguage] = [
        "makefile": .makefile, "gnumakefile": .makefile, "justfile": .makefile,
        "containerfile": .dockerfile, "cmakelists.txt": .cmake,
        "gemfile": .ruby, "rakefile": .ruby, "podfile": .ruby, "fastfile": .ruby, "appfile": .ruby,
        "brewfile": .ruby, "vagrantfile": .ruby, "guardfile": .ruby, "dangerfile": .ruby,
        ".bashrc": .shell, ".bash_profile": .shell, ".zshrc": .shell, ".zprofile": .shell,
        ".zshenv": .shell, ".profile": .shell, ".envrc": .shell,
        ".editorconfig": .ini, ".gitconfig": .ini, ".gitmodules": .ini, ".gitattributes": .ini,
        ".babelrc": .json, ".eslintrc": .json, ".prettierrc": .json, ".swcrc": .json,
        "cargo.lock": .toml, "poetry.lock": .toml, "pipfile": .toml, "go.mod": .go, "go.sum": .ini,
        "build": .python, "workspace": .python, "build.bazel": .python, "workspace.bazel": .python,
    ]

    private static let byExtension: [String: CodeLanguage] = {
        var map: [String: CodeLanguage] = [:]
        func add(_ language: CodeLanguage, _ extensions: String) {
            for ext in extensions.split(separator: " ") { map[String(ext)] = language }
        }
        add(.c, "c")
        add(.cpp, "h cc cpp cxx c++ hpp hh hxx h++ ipp inl tpp ino cu cuh")
        add(.objectiveC, "m mm")
        add(.csharp, "cs csx cake")
        add(.java, "java jav")
        add(.kotlin, "kt kts")
        add(.scala, "scala sc sbt")
        add(.groovy, "groovy gradle gvy jenkinsfile")
        add(.swift, "swift swiftinterface")
        add(.go, "go")
        add(.rust, "rs")
        add(.javascript, "js mjs cjs jsx")
        add(.typescript, "ts mts cts tsx")
        add(.dart, "dart")
        add(.php, "php phtml php3 php4 php5 phps")
        add(.zig, "zig zon")
        add(.solidity, "sol")
        add(.shader, "glsl vert frag geom comp tesc tese hlsl wgsl metal shader fx cginc")
        add(.protobuf, "proto")
        add(.graphql, "graphql gql graphqls")
        add(.python, "py pyw pyi pyx pxd ipy bzl star")
        add(.ruby, "rb rake gemspec podspec ru jbuilder")
        add(.shell, "sh bash zsh fish ksh command bats")
        add(.powershell, "ps1 psm1 psd1")
        add(.perl, "pl pm pod")
        add(.r, "r")
        add(.elixir, "ex exs heex")
        add(.julia, "jl")
        add(.yaml, "yaml yml")
        add(.toml, "toml")
        add(.ini, "ini cfg conf cnf properties desktop service socket timer prefs inf reg")
        add(.dockerfile, "dockerfile")
        add(.makefile, "mk mak make")
        add(.cmake, "cmake")
        add(.terraform, "tf tfvars hcl nomad")
        add(.nix, "nix")
        add(.sql, "sql psql pgsql mysql ddl dml")
        add(.lua, "lua luau")
        add(.haskell, "hs lhs elm")
        add(.erlang, "erl hrl")
        add(.latex, "tex sty cls bib ltx")
        add(.lisp, "lisp el scm ss rkt clj cljs cljc edn fnl")
        add(.html, "html htm xhtml erb ejs hbs handlebars mustache jinja j2 njk twig liquid astro")
        add(.xml, "xml xsd xsl xslt plist svg xib storyboard csproj vcxproj fsproj props targets resx xaml wsdl rss atom kml gpx entitlements")
        add(.vue, "vue svelte")
        add(.css, "css")
        add(.scss, "scss sass less styl")
        add(.json, "json jsonc json5 jsonl ndjson geojson webmanifest har ipynb babelrc")
        add(.markdown, "md markdown mdx mkd mdown")
        add(.diff, "diff patch rej")
        return map
    }()
}

/// Colours source in one pass over the whole text, so block comments, long
/// strings, script blocks and fenced code carry across lines. A diff colours
/// each line on its own, so nothing a hunk cut in half can leak forward.
enum CodeHighlighter {
    static func tokens(_ text: String, language: CodeLanguage) -> [CodeToken] {
        var scanner = Scanner(text: Array(text.utf16), language: language)
        scanner.run()
        return scanner.tokens
    }

    // MARK: - Colours

    static func color(_ kind: CodeTokenKind) -> NSColor {
        switch kind {
        case .comment: return palette(light: 0x6C7986, dark: 0x7F8C98)
        case .string: return palette(light: 0xC41A16, dark: 0xFC6A5D)
        case .number: return palette(light: 0x1C00CF, dark: 0xD9C97C)
        case .keyword, .heading: return palette(light: 0x9B2393, dark: 0xFC5FA3)
        case .type: return palette(light: 0x0B4F79, dark: 0x5DD8FF)
        case .function: return palette(light: 0x326D74, dark: 0x67B7A4)
        case .attribute: return palette(light: 0x815F03, dark: 0xFD8F3F)
        case .tag: return palette(light: 0x0F68A0, dark: 0x41A1C0)
        case .meta: return palette(light: 0x643820, dark: 0xFD8F3F)
        case .addition: return .systemGreen
        case .deletion: return .systemRed
        }
    }

    private static func palette(light: Int, dark: Int) -> NSColor {
        func rgb(_ value: Int) -> NSColor {
            NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                    blue: CGFloat(value & 0xFF) / 255, alpha: 1)
        }
        return NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? rgb(dark) : rgb(light)
        }
    }

    /// Applies colours to `text` that starts at `offset` within `storage`.
    static func apply(_ tokens: [CodeToken], to storage: NSMutableAttributedString, offset: Int = 0, font: NSFont) {
        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
        for token in tokens {
            let range = NSRange(location: token.range.location + offset, length: token.range.length)
            guard NSMaxRange(range) <= storage.length else { continue }
            storage.addAttribute(.foregroundColor, value: color(token.kind), range: range)
            if token.kind == .heading { storage.addAttribute(.font, value: bold, range: range) }
        }
    }
}

// MARK: - Rules

private struct StringRule {
    let open: [UInt16]
    let close: [UInt16]
    let multiline: Bool
    let escapes: Bool
}

private struct Syntax {
    enum Mode { case code, markup, json, yaml, ini, css, markdown, diff }
    var mode: Mode = .code
    var lineComments: [[UInt16]] = []
    var blockComments: [([UInt16], [UInt16])] = []
    var strings: [StringRule] = []
    var keywords: Set<String> = []
    var types: Set<String> = []
    var capitalizedTypes = false
    var caseInsensitive = false
    /// `#` only starts a comment after whitespace, as in shells.
    var hashNeedsBoundary = false
    var decorators = false
    var preprocessor = false
    var variables = false
    var functionCalls = true

    static func rules(for language: CodeLanguage) -> Syntax {
        switch language {
        case .c: return curly(Words.c, types: Words.cTypes)
        case .cpp, .shader: return curly(Words.c.union(Words.cpp), types: Words.cTypes, rawStrings: true)
        case .objectiveC: return curly(Words.c.union(Words.objectiveC), types: Words.cTypes, decorators: true)
        case .csharp: return curly(Words.csharp, extra: [rule("@\"", "\"", multiline: true, escapes: false), rule("$\"", "\"")], decorators: false)
        case .java: return curly(Words.java, extra: [rule("\"\"\"", "\"\"\"", multiline: true)], decorators: true)
        case .kotlin: return curly(Words.kotlin, extra: [rule("\"\"\"", "\"\"\"", multiline: true, escapes: false)], decorators: true)
        case .scala: return curly(Words.scala, extra: [rule("\"\"\"", "\"\"\"", multiline: true, escapes: false)], decorators: true)
        case .groovy: return curly(Words.java.union(Words.groovy), extra: [rule("'''", "'''", multiline: true), rule("\"\"\"", "\"\"\"", multiline: true)], decorators: true)
        case .swift: return curly(Words.swift, extra: [rule("#\"", "\"#"), rule("\"\"\"", "\"\"\"", multiline: true)], decorators: true, preprocessor: false)
        case .go: return curly(Words.go, extra: [rule("`", "`", multiline: true, escapes: false)])
        case .rust: return curly(Words.rust, extra: [rule("r#\"", "\"#", multiline: true, escapes: false)], noChars: true)
        case .javascript, .typescript:
            return curly(Words.javascript, extra: [rule("`", "`", multiline: true)], decorators: true)
        case .dart: return curly(Words.dart, extra: [rule("'''", "'''", multiline: true), rule("\"\"\"", "\"\"\"", multiline: true)], decorators: true)
        case .php:
            var syntax = curly(Words.php)
            syntax.lineComments.append(utf16("#"))
            syntax.preprocessor = false
            syntax.variables = true
            syntax.caseInsensitive = true
            return syntax
        case .zig: return curly(Words.zig, extra: [rule("\\\\", "\n")])
        case .solidity: return curly(Words.solidity)
        case .protobuf: return curly(Words.protobuf)
        case .graphql:
            return Syntax(lineComments: [utf16("#")], strings: [rule("\"\"\"", "\"\"\"", multiline: true), rule("\"", "\"")],
                          keywords: Words.graphql, capitalizedTypes: true)
        case .python:
            return Syntax(lineComments: [utf16("#")],
                          strings: [rule("\"\"\"", "\"\"\"", multiline: true), rule("'''", "'''", multiline: true),
                                    rule("\"", "\""), rule("'", "'")],
                          keywords: Words.python, types: Words.pythonTypes, capitalizedTypes: true, decorators: true)
        case .ruby:
            return Syntax(lineComments: [utf16("#")], blockComments: [(utf16("=begin"), utf16("=end"))],
                          strings: [rule("\"", "\""), rule("'", "'"), rule("`", "`")],
                          keywords: Words.ruby, capitalizedTypes: true, variables: true)
        case .shell:
            return Syntax(lineComments: [utf16("#")],
                          strings: [rule("\"", "\"", multiline: true), rule("'", "'", multiline: true, escapes: false), rule("`", "`")],
                          keywords: Words.shell, hashNeedsBoundary: true, variables: true)
        case .powershell:
            return Syntax(lineComments: [utf16("#")], blockComments: [(utf16("<#"), utf16("#>"))],
                          strings: [rule("\"", "\""), rule("'", "'", escapes: false)],
                          keywords: Words.powershell, caseInsensitive: true, hashNeedsBoundary: true, variables: true)
        case .perl:
            return Syntax(lineComments: [utf16("#")], strings: [rule("\"", "\""), rule("'", "'")],
                          keywords: Words.perl, hashNeedsBoundary: true, variables: true)
        case .r:
            return Syntax(lineComments: [utf16("#")], strings: [rule("\"", "\""), rule("'", "'")], keywords: Words.r)
        case .elixir:
            return Syntax(lineComments: [utf16("#")], strings: [rule("\"\"\"", "\"\"\"", multiline: true), rule("\"", "\""), rule("'", "'")],
                          keywords: Words.elixir, capitalizedTypes: true, decorators: true)
        case .julia:
            return Syntax(lineComments: [utf16("#")], blockComments: [(utf16("#="), utf16("=#"))],
                          strings: [rule("\"\"\"", "\"\"\"", multiline: true), rule("\"", "\"")],
                          keywords: Words.julia, capitalizedTypes: true, decorators: true)
        case .yaml: return Syntax(mode: .yaml, lineComments: [utf16("#")], strings: [rule("\"", "\""), rule("'", "'", escapes: false)],
                                  keywords: Words.yaml, hashNeedsBoundary: true, functionCalls: false)
        case .toml, .ini:
            return Syntax(mode: .ini, lineComments: [utf16("#"), utf16(";")],
                          strings: [rule("\"\"\"", "\"\"\"", multiline: true), rule("'''", "'''", multiline: true),
                                    rule("\"", "\""), rule("'", "'", escapes: false)],
                          keywords: ["true", "false", "yes", "no", "on", "off", "null"], functionCalls: false)
        case .dockerfile:
            return Syntax(lineComments: [utf16("#")], strings: [rule("\"", "\""), rule("'", "'", escapes: false)],
                          keywords: Words.dockerfile, caseInsensitive: true, hashNeedsBoundary: true, variables: true, functionCalls: false)
        case .makefile:
            return Syntax(lineComments: [utf16("#")], strings: [rule("\"", "\""), rule("'", "'")],
                          keywords: Words.makefile, hashNeedsBoundary: true, variables: true, functionCalls: false)
        case .cmake:
            return Syntax(lineComments: [utf16("#")], strings: [rule("\"", "\"")], keywords: Words.cmake,
                          caseInsensitive: true, variables: true)
        case .terraform:
            return Syntax(lineComments: [utf16("#"), utf16("//")], blockComments: [(utf16("/*"), utf16("*/"))],
                          strings: [rule("\"", "\"")], keywords: Words.terraform, variables: true)
        case .nix:
            return Syntax(lineComments: [utf16("#")], blockComments: [(utf16("/*"), utf16("*/"))],
                          strings: [rule("''", "''", multiline: true, escapes: false), rule("\"", "\"")], keywords: Words.nix)
        case .sql:
            return Syntax(lineComments: [utf16("--"), utf16("#")], blockComments: [(utf16("/*"), utf16("*/"))],
                          strings: [rule("'", "'"), rule("\"", "\""), rule("`", "`")],
                          keywords: Words.sql, types: Words.sqlTypes, caseInsensitive: true, hashNeedsBoundary: true)
        case .lua:
            return Syntax(lineComments: [utf16("--")], blockComments: [(utf16("--[["), utf16("]]"))],
                          strings: [rule("[[", "]]", multiline: true, escapes: false), rule("\"", "\""), rule("'", "'")],
                          keywords: Words.lua)
        case .haskell:
            return Syntax(lineComments: [utf16("--")], blockComments: [(utf16("{-"), utf16("-}"))],
                          strings: [rule("\"", "\"")], keywords: Words.haskell, capitalizedTypes: true)
        case .erlang:
            return Syntax(lineComments: [utf16("%")], strings: [rule("\"", "\"")], keywords: Words.erlang, capitalizedTypes: true)
        case .latex:
            return Syntax(lineComments: [utf16("%")], strings: [], keywords: [], variables: true, functionCalls: false)
        case .lisp:
            return Syntax(lineComments: [utf16(";")], blockComments: [(utf16("#|"), utf16("|#"))], strings: [rule("\"", "\"", multiline: true)],
                          keywords: Words.lisp, functionCalls: false)
        case .html, .xml, .vue: return Syntax(mode: .markup)
        case .css: return Syntax(mode: .css, blockComments: [(utf16("/*"), utf16("*/"))], strings: [rule("\"", "\""), rule("'", "'")],
                                 keywords: Words.css)
        case .scss: return Syntax(mode: .css, lineComments: [utf16("//")], blockComments: [(utf16("/*"), utf16("*/"))],
                                  strings: [rule("\"", "\""), rule("'", "'")], keywords: Words.css, variables: true)
        case .json: return Syntax(mode: .json, lineComments: [utf16("//")], blockComments: [(utf16("/*"), utf16("*/"))],
                                  strings: [rule("\"", "\""), rule("'", "'")], keywords: ["true", "false", "null", "NaN", "Infinity"],
                                  functionCalls: false)
        case .markdown: return Syntax(mode: .markdown)
        case .diff: return Syntax(mode: .diff)
        }
    }

    private static func curly(_ keywords: Set<String>, types: Set<String> = [], extra: [StringRule] = [],
                              decorators: Bool = false, preprocessor: Bool = true, rawStrings: Bool = false,
                              noChars: Bool = false) -> Syntax {
        var strings = extra
        if rawStrings { strings.append(rule("R\"(", ")\"", multiline: true, escapes: false)) }
        strings.append(rule("\"", "\""))
        if !noChars { strings.append(rule("'", "'")) }
        return Syntax(lineComments: [utf16("//")], blockComments: [(utf16("/*"), utf16("*/"))], strings: strings,
                      keywords: keywords, types: types, capitalizedTypes: true, decorators: decorators,
                      preprocessor: preprocessor)
    }
}

private func utf16(_ text: String) -> [UInt16] { Array(text.utf16) }

private func rule(_ open: String, _ close: String, multiline: Bool = false, escapes: Bool = true) -> StringRule {
    StringRule(open: utf16(open), close: utf16(close), multiline: multiline, escapes: escapes)
}

// MARK: - Scanner

private enum Unit {
    static let newline: UInt16 = 10, space: UInt16 = 32, tab: UInt16 = 9, cr: UInt16 = 13
    static let hash: UInt16 = 35, dollar: UInt16 = 36, at: UInt16 = 64, underscore: UInt16 = 95
    static let less: UInt16 = 60, greater: UInt16 = 62, slash: UInt16 = 47, equals: UInt16 = 61
    static let colon: UInt16 = 58, backslash: UInt16 = 92, openParen: UInt16 = 40, openBrace: UInt16 = 123
    static let closeBrace: UInt16 = 125, openBracket: UInt16 = 91, closeBracket: UInt16 = 93, ampersand: UInt16 = 38
    static let semicolon: UInt16 = 59, dash: UInt16 = 45, plus: UInt16 = 43, dot: UInt16 = 46, star: UInt16 = 42
    static let backtick: UInt16 = 96, tilde: UInt16 = 126, bang: UInt16 = 33, quote: UInt16 = 34, apostrophe: UInt16 = 39
}

private struct Scanner {
    let text: [UInt16]
    let language: CodeLanguage
    let syntax: Syntax
    var tokens: [CodeToken] = []
    let bounds: Range<Int>

    init(text: [UInt16], language: CodeLanguage, range: Range<Int>? = nil) {
        self.text = text
        self.language = language
        syntax = Syntax.rules(for: language)
        bounds = range ?? 0..<text.count
    }

    mutating func run() {
        switch syntax.mode {
        case .code, .yaml, .ini: code(bounds)
        case .markup: markup(bounds)
        case .json: json(bounds)
        case .css: css(bounds)
        case .markdown: markdown(bounds)
        case .diff: diff(bounds)
        }
    }

    // MARK: helpers

    private mutating func emit(_ start: Int, _ end: Int, _ kind: CodeTokenKind) {
        guard end > start else { return }
        tokens.append(CodeToken(range: NSRange(location: start, length: end - start), kind: kind))
    }

    private func matches(_ marker: [UInt16], at index: Int, limit: Int) -> Bool {
        guard !marker.isEmpty, index + marker.count <= limit else { return false }
        for offset in 0..<marker.count where text[index + offset] != marker[offset] { return false }
        return true
    }

    private func find(_ marker: [UInt16], from index: Int, limit: Int) -> Int? {
        var cursor = index
        while cursor < limit {
            if matches(marker, at: cursor, limit: limit) { return cursor }
            cursor += 1
        }
        return nil
    }

    private func lineEnd(from index: Int, limit: Int) -> Int {
        var cursor = index
        while cursor < limit, text[cursor] != Unit.newline { cursor += 1 }
        return cursor
    }

    private static func isLetter(_ unit: UInt16) -> Bool { (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) }
    private static func isDigit(_ unit: UInt16) -> Bool { unit >= 48 && unit <= 57 }
    private static func isSpace(_ unit: UInt16) -> Bool { unit == Unit.space || unit == Unit.tab || unit == Unit.cr }
    private static func isIdentifierStart(_ unit: UInt16) -> Bool { isLetter(unit) || unit == Unit.underscore || unit > 127 }
    private static func isIdentifier(_ unit: UInt16) -> Bool { isIdentifierStart(unit) || isDigit(unit) }

    private func word(_ start: Int, _ end: Int) -> String {
        String(utf16CodeUnits: Array(text[start..<end]), count: end - start)
    }

    private func nextNonSpace(from index: Int, limit: Int) -> UInt16? {
        var cursor = index
        while cursor < limit, Scanner.isSpace(text[cursor]) { cursor += 1 }
        return cursor < limit ? text[cursor] : nil
    }

    /// A string from `start`, `rule.open` already matched. Returns its end.
    private func stringEnd(_ rule: StringRule, from start: Int, limit: Int) -> Int {
        var cursor = start + rule.open.count
        while cursor < limit {
            if rule.escapes, text[cursor] == Unit.backslash { cursor += 2; continue }
            if matches(rule.close, at: cursor, limit: limit) { return cursor + rule.close.count }
            if !rule.multiline, text[cursor] == Unit.newline { return cursor }
            cursor += 1
        }
        return limit
    }

    private func number(from start: Int, limit: Int) -> Int {
        var cursor = start + 1
        while cursor < limit {
            let unit = text[cursor]
            if Scanner.isIdentifier(unit) || unit == Unit.dot { cursor += 1; continue }
            // An exponent sign belongs to the number: 1e-9.
            if (unit == Unit.plus || unit == Unit.dash), cursor > start, text[cursor - 1] == 101 || text[cursor - 1] == 69 { cursor += 1; continue }
            break
        }
        return cursor
    }

    // MARK: code

    private mutating func code(_ range: Range<Int>) {
        var index = range.lowerBound
        let limit = range.upperBound
        var lineStart = true
        var yamlKeyChecked = false
        scan: while index < limit {
            let unit = text[index]
            if unit == Unit.newline { lineStart = true; yamlKeyChecked = false; index += 1; continue }
            if Scanner.isSpace(unit) { index += 1; continue }

            if syntax.mode == .yaml, !yamlKeyChecked {
                yamlKeyChecked = true
                // A list item's key follows its dash: `- name: value`.
                var keyStart = index
                if unit == Unit.dash, keyStart + 1 < limit, Scanner.isSpace(text[keyStart + 1]) {
                    keyStart += 1
                    while keyStart < limit, Scanner.isSpace(text[keyStart]) { keyStart += 1 }
                }
                if keyStart < limit, let end = yamlKey(from: keyStart, limit: limit) {
                    emit(keyStart, end, .attribute)
                    index = end
                    lineStart = false
                    continue
                }
            }
            if syntax.mode == .ini, lineStart {
                if unit == Unit.openBracket {
                    let end = lineEnd(from: index, limit: limit)
                    if let close = (index..<end).last(where: { text[$0] == Unit.closeBracket }) {
                        emit(index, close + 1, .type)
                        index = close + 1
                        lineStart = false
                        continue
                    }
                }
                if let end = iniKey(from: index, limit: limit) {
                    emit(index, end, .attribute)
                    index = end
                    lineStart = false
                    continue
                }
            }

            for (open, close) in syntax.blockComments where matches(open, at: index, limit: limit) {
                let end = find(close, from: index + open.count, limit: limit).map { $0 + close.count } ?? limit
                emit(index, end, .comment)
                index = end
                lineStart = false
                continue scan
            }
            for marker in syntax.lineComments where matches(marker, at: index, limit: limit) {
                let boundary = index == range.lowerBound || Scanner.isSpace(text[index - 1]) || text[index - 1] == Unit.newline
                if marker == [Unit.hash], syntax.hashNeedsBoundary, !boundary { break }
                // `#` in a C file is a preprocessor line, not a comment.
                if marker == [Unit.hash], syntax.preprocessor { break }
                let end = lineEnd(from: index, limit: limit)
                emit(index, end, .comment)
                index = end
                continue scan
            }
            if syntax.preprocessor, lineStart, unit == Unit.hash {
                var end = index + 1
                while end < limit, Scanner.isSpace(text[end]) { end += 1 }
                while end < limit, Scanner.isIdentifier(text[end]) { end += 1 }
                emit(index, end, .meta)
                index = end
                lineStart = false
                continue
            }
            for rule in syntax.strings where matches(rule.open, at: index, limit: limit) {
                let end = stringEnd(rule, from: index, limit: limit)
                emit(index, end, .string)
                index = end
                lineStart = false
                continue scan
            }
            lineStart = false
            if Scanner.isDigit(unit), index == range.lowerBound || !Scanner.isIdentifier(text[index - 1]) {
                let end = number(from: index, limit: limit)
                emit(index, end, .number)
                index = end
                continue
            }
            if syntax.decorators, unit == Unit.at, index + 1 < limit, Scanner.isIdentifierStart(text[index + 1]) {
                var end = index + 1
                while end < limit, Scanner.isIdentifier(text[end]) || text[end] == Unit.dot { end += 1 }
                emit(index, end, .meta)
                index = end
                continue
            }
            if syntax.variables, unit == Unit.dollar || (unit == Unit.at && language == .perl) {
                var end = index + 1
                if end < limit, text[end] == Unit.openBrace || text[end] == Unit.openParen {
                    let close: UInt16 = text[end] == Unit.openBrace ? Unit.closeBrace : 41
                    while end < limit, text[end] != close, text[end] != Unit.newline { end += 1 }
                    if end < limit, text[end] == close { end += 1 }
                } else {
                    while end < limit, Scanner.isIdentifier(text[end]) { end += 1 }
                }
                if end > index + 1 { emit(index, end, .meta) }
                index = max(end, index + 1)
                continue
            }
            if language == .latex, unit == Unit.backslash {
                var end = index + 1
                while end < limit, Scanner.isLetter(text[end]) { end += 1 }
                emit(index, max(end, index + 2), .keyword)
                index = max(end, index + 2)
                continue
            }
            if Scanner.isIdentifierStart(unit) {
                var end = index + 1
                while end < limit, Scanner.isIdentifier(text[end]) || (language == .lisp && text[end] == Unit.dash) { end += 1 }
                let value = word(index, end)
                let key = syntax.caseInsensitive ? value.lowercased() : value
                if syntax.keywords.contains(key) {
                    emit(index, end, .keyword)
                } else if syntax.types.contains(key) || (syntax.capitalizedTypes && Scanner.isUppercase(text[index])) {
                    emit(index, end, .type)
                } else if syntax.functionCalls, nextNonSpace(from: end, limit: limit) == Unit.openParen {
                    emit(index, end, .function)
                }
                index = end
                continue
            }
            index += 1
        }
    }

    private static func isUppercase(_ unit: UInt16) -> Bool { unit >= 65 && unit <= 90 }

    /// `key:` at the start of a YAML line (after an optional list dash), not `http://`.
    private func yamlKey(from start: Int, limit: Int) -> Int? {
        var cursor = start
        if text[cursor] == Unit.dash, cursor + 1 < limit, Scanner.isSpace(text[cursor + 1]) { return nil }
        if text[cursor] == Unit.quote || text[cursor] == Unit.apostrophe || text[cursor] == Unit.hash { return nil }
        while cursor < limit, text[cursor] != Unit.newline {
            if text[cursor] == Unit.colon {
                let next = cursor + 1 < limit ? text[cursor + 1] : Unit.newline
                return next == Unit.newline || Scanner.isSpace(next) ? cursor : nil
            }
            if text[cursor] == Unit.hash { return nil }
            cursor += 1
        }
        return nil
    }

    /// `key =` or `key:` at the start of an INI/TOML line.
    private func iniKey(from start: Int, limit: Int) -> Int? {
        guard Scanner.isIdentifierStart(text[start]) || text[start] == Unit.quote else { return nil }
        var cursor = start
        while cursor < limit, text[cursor] != Unit.newline {
            let unit = text[cursor]
            if unit == Unit.equals || unit == Unit.colon { return cursor }
            if !(Scanner.isIdentifier(unit) || unit == Unit.dot || unit == Unit.dash || Scanner.isSpace(unit) || unit == Unit.quote) {
                return nil
            }
            cursor += 1
        }
        return nil
    }

    // MARK: markup

    private mutating func markup(_ range: Range<Int>) {
        var index = range.lowerBound
        let limit = range.upperBound
        while index < limit {
            if matches(utf16("<!--"), at: index, limit: limit) {
                let end = find(utf16("-->"), from: index + 4, limit: limit).map { $0 + 3 } ?? limit
                emit(index, end, .comment)
                index = end
                continue
            }
            if matches(utf16("<![CDATA["), at: index, limit: limit) {
                let end = find(utf16("]]>"), from: index + 9, limit: limit).map { $0 + 3 } ?? limit
                emit(index, end, .string)
                index = end
                continue
            }
            let unit = text[index]
            if unit == Unit.less, index + 1 < limit,
               Scanner.isLetter(text[index + 1]) || text[index + 1] == Unit.slash || text[index + 1] == Unit.bang || text[index + 1] == 63 {
                var cursor = index + 1
                if text[cursor] == Unit.slash || text[cursor] == Unit.bang || text[cursor] == 63 { cursor += 1 }
                let nameStart = cursor
                while cursor < limit, Scanner.isIdentifier(text[cursor]) || text[cursor] == Unit.dash
                        || text[cursor] == Unit.colon || text[cursor] == Unit.dot { cursor += 1 }
                let tagName = word(nameStart, cursor).lowercased()
                emit(index, cursor, .tag)
                var attributes: [String: String] = [:]
                var lastAttribute: String?
                // Attributes until the closing `>`.
                while cursor < limit, text[cursor] != Unit.greater {
                    let current = text[cursor]
                    if current == Unit.quote || current == Unit.apostrophe {
                        let close = find([current], from: cursor + 1, limit: limit) ?? (limit - 1)
                        emit(cursor, close + 1, .string)
                        if let name = lastAttribute { attributes[name] = word(cursor + 1, close) }
                        cursor = close + 1
                        continue
                    }
                    if Scanner.isIdentifierStart(current) || current == Unit.at || current == Unit.colon {
                        let start = cursor
                        while cursor < limit, Scanner.isIdentifier(text[cursor]) || text[cursor] == Unit.dash
                                || text[cursor] == Unit.colon || text[cursor] == Unit.at || text[cursor] == Unit.dot { cursor += 1 }
                        emit(start, cursor, .attribute)
                        lastAttribute = word(start, cursor).lowercased()
                        continue
                    }
                    if current == Unit.slash { emit(cursor, cursor + 1, .tag) }
                    cursor += 1
                }
                if cursor < limit { emit(cursor, cursor + 1, .tag); cursor += 1 }
                index = cursor
                // Script and style bodies are coloured as the language they hold.
                if text[nameStart - 1] != Unit.slash, tagName == "script" || tagName == "style" {
                    let close = find(utf16("</" + tagName), from: index, limit: limit)
                        ?? find(utf16("</" + tagName.uppercased()), from: index, limit: limit) ?? limit
                    let embedded: CodeLanguage = tagName == "style" ? .css
                        : (attributes["lang"].map { $0.hasPrefix("ts") } ?? false) ? .typescript : .javascript
                    var inner = Scanner(text: text, language: embedded, range: index..<close)
                    inner.run()
                    tokens.append(contentsOf: inner.tokens)
                    index = close
                }
                continue
            }
            if unit == Unit.ampersand {
                var end = index + 1
                while end < limit, end - index < 12, Scanner.isIdentifier(text[end]) || text[end] == Unit.hash { end += 1 }
                if end < limit, text[end] == Unit.semicolon { emit(index, end + 1, .meta); index = end + 1; continue }
            }
            index += 1
        }
    }

    // MARK: json

    private mutating func json(_ range: Range<Int>) {
        var index = range.lowerBound
        let limit = range.upperBound
        scan: while index < limit {
            let unit = text[index]
            for (open, close) in syntax.blockComments where matches(open, at: index, limit: limit) {
                let end = find(close, from: index + open.count, limit: limit).map { $0 + close.count } ?? limit
                emit(index, end, .comment)
                index = end
                continue scan
            }
            for marker in syntax.lineComments where matches(marker, at: index, limit: limit) {
                let end = lineEnd(from: index, limit: limit)
                emit(index, end, .comment)
                index = end
                continue scan
            }
            if unit == Unit.quote || unit == Unit.apostrophe {
                let end = stringEnd(StringRule(open: [unit], close: [unit], multiline: false, escapes: true), from: index, limit: limit)
                // A string followed by `:` is a key.
                emit(index, end, nextNonSpace(from: end, limit: limit) == Unit.colon ? .attribute : .string)
                index = end
                continue
            }
            if Scanner.isDigit(unit) || (unit == Unit.dash && index + 1 < limit && Scanner.isDigit(text[index + 1])) {
                let end = number(from: index, limit: limit)
                emit(index, end, .number)
                index = end
                continue
            }
            if Scanner.isLetter(unit) {
                var end = index + 1
                while end < limit, Scanner.isIdentifier(text[end]) { end += 1 }
                if syntax.keywords.contains(word(index, end)) { emit(index, end, .keyword) }
                index = end
                continue
            }
            index += 1
        }
    }

    // MARK: css

    private mutating func css(_ range: Range<Int>) {
        var index = range.lowerBound
        let limit = range.upperBound
        var depth = 0
        scan: while index < limit {
            let unit = text[index]
            for (open, close) in syntax.blockComments where matches(open, at: index, limit: limit) {
                let end = find(close, from: index + open.count, limit: limit).map { $0 + close.count } ?? limit
                emit(index, end, .comment)
                index = end
                continue scan
            }
            for marker in syntax.lineComments where matches(marker, at: index, limit: limit) {
                // `//` inside url(http://…) is not a comment.
                if index > range.lowerBound, text[index - 1] == Unit.colon { break }
                let end = lineEnd(from: index, limit: limit)
                emit(index, end, .comment)
                index = end
                continue scan
            }
            for rule in syntax.strings where matches(rule.open, at: index, limit: limit) {
                let end = stringEnd(rule, from: index, limit: limit)
                emit(index, end, .string)
                index = end
                continue scan
            }
            if unit == Unit.openBrace { depth += 1; index += 1; continue }
            if unit == Unit.closeBrace { depth = max(0, depth - 1); index += 1; continue }
            if unit == Unit.at, index + 1 < limit, Scanner.isLetter(text[index + 1]) {
                var end = index + 1
                while end < limit, Scanner.isIdentifier(text[end]) || text[end] == Unit.dash { end += 1 }
                emit(index, end, .keyword)
                index = end
                continue
            }
            if syntax.variables, unit == Unit.dollar {
                var end = index + 1
                while end < limit, Scanner.isIdentifier(text[end]) || text[end] == Unit.dash { end += 1 }
                emit(index, end, .meta)
                index = end
                continue
            }
            if unit == Unit.hash, depth > 0 {
                var end = index + 1
                while end < limit, Scanner.isIdentifier(text[end]) { end += 1 }
                emit(index, end, .number)
                index = end
                continue
            }
            if Scanner.isDigit(unit) || (unit == Unit.dot && index + 1 < limit && Scanner.isDigit(text[index + 1])) {
                var end = index + 1
                while end < limit, Scanner.isIdentifier(text[end]) || text[end] == Unit.dot || text[end] == 37 { end += 1 }
                emit(index, end, .number)
                index = end
                continue
            }
            if Scanner.isIdentifierStart(unit) || unit == Unit.dash || unit == Unit.dot || (unit == Unit.hash && depth == 0) {
                let start = index
                var end = index + 1
                while end < limit, Scanner.isIdentifier(text[end]) || text[end] == Unit.dash { end += 1 }
                let next = nextNonSpace(from: end, limit: limit)
                if depth > 0, next == Unit.colon, unit != Unit.dot {
                    emit(start, end, .attribute)
                } else if depth == 0 || next == Unit.openBrace {
                    emit(start, end, unit == Unit.dot || unit == Unit.hash ? .type : .tag)
                } else if syntax.keywords.contains(word(start, end)) {
                    emit(start, end, .keyword)
                } else if next == Unit.openParen {
                    emit(start, end, .function)
                }
                index = end
                continue
            }
            index += 1
        }
    }

    // MARK: markdown

    private mutating func markdown(_ range: Range<Int>) {
        var index = range.lowerBound
        let limit = range.upperBound
        while index < limit {
            let end = lineEnd(from: index, limit: limit)
            var first = index
            while first < end, Scanner.isSpace(text[first]) { first += 1 }
            // Fenced code: coloured as the language its info string names.
            if matches(utf16("```"), at: first, limit: end) || matches(utf16("~~~"), at: first, limit: end) {
                let fence = Array(text[first..<first + 3])
                let info = word(first + 3, end).trimmingCharacters(in: .whitespaces).lowercased()
                emit(index, end, .meta)
                var bodyStart = min(end + 1, limit)
                var cursor = bodyStart
                var closing = limit
                while cursor < limit {
                    let lineStop = lineEnd(from: cursor, limit: limit)
                    var start = cursor
                    while start < lineStop, Scanner.isSpace(text[start]) { start += 1 }
                    if matches(fence, at: start, limit: lineStop) { closing = cursor; break }
                    cursor = min(lineStop + 1, limit)
                }
                bodyStart = min(bodyStart, closing)
                if let language = Self.fenceLanguage(info) {
                    var inner = Scanner(text: text, language: language, range: bodyStart..<closing)
                    inner.run()
                    tokens.append(contentsOf: inner.tokens)
                } else {
                    emit(bodyStart, closing, .string)
                }
                if closing < limit {
                    let closeEnd = lineEnd(from: closing, limit: limit)
                    emit(closing, closeEnd, .meta)
                    index = min(closeEnd + 1, limit)
                } else {
                    index = limit
                }
                continue
            }
            if first < end, text[first] == Unit.hash {
                var level = first
                while level < end, text[level] == Unit.hash { level += 1 }
                if level - first <= 6, level == end || Scanner.isSpace(text[level]) {
                    emit(first, end, .heading)
                    index = min(end + 1, limit)
                    continue
                }
            }
            if first < end, text[first] == Unit.greater {
                emit(first, end, .comment)
                index = min(end + 1, limit)
                continue
            }
            if first + 1 < end, text[first] == Unit.dash || text[first] == Unit.star || text[first] == Unit.plus,
               Scanner.isSpace(text[first + 1]) {
                emit(first, first + 1, .keyword)
            }
            inlineMarkdown(first, end)
            index = min(end + 1, limit)
        }
    }

    private mutating func inlineMarkdown(_ start: Int, _ end: Int) {
        var index = start
        while index < end {
            let unit = text[index]
            if unit == Unit.backtick {
                if let close = find([Unit.backtick], from: index + 1, limit: end) {
                    emit(index, close + 1, .string)
                    index = close + 1
                    continue
                }
            }
            if unit == Unit.star || unit == Unit.underscore, index + 1 < end, text[index + 1] == unit {
                if let close = find([unit, unit], from: index + 2, limit: end) {
                    emit(index, close + 2, .keyword)
                    index = close + 2
                    continue
                }
            }
            if unit == Unit.openBracket, let close = find([Unit.closeBracket], from: index + 1, limit: end),
               close + 1 < end, text[close + 1] == Unit.openParen,
               let paren = find([41], from: close + 2, limit: end) {
                emit(index, close + 1, .attribute)
                emit(close + 1, paren + 1, .meta)
                index = paren + 1
                continue
            }
            index += 1
        }
    }

    private static func fenceLanguage(_ info: String) -> CodeLanguage? {
        let name = info.split(whereSeparator: { $0 == " " || $0 == "{" || $0 == "," }).first.map(String.init) ?? ""
        guard !name.isEmpty else { return nil }
        let aliases: [String: CodeLanguage] = [
            "js": .javascript, "ts": .typescript, "tsx": .typescript, "jsx": .javascript, "sh": .shell, "bash": .shell,
            "zsh": .shell, "console": .shell, "shell": .shell, "py": .python, "rb": .ruby, "yml": .yaml, "objc": .objectiveC,
            "c++": .cpp, "cs": .csharp, "kt": .kotlin, "rs": .rust, "golang": .go, "ps1": .powershell, "md": .markdown,
            "html": .html, "xml": .xml, "json": .json, "jsonc": .json, "diff": .diff, "patch": .diff, "dockerfile": .dockerfile,
        ]
        return aliases[name] ?? CodeLanguage(rawValue: name) ?? CodeLanguage.detect(fileName: "x." + name)
    }

    // MARK: diff

    private mutating func diff(_ range: Range<Int>) {
        var index = range.lowerBound
        let limit = range.upperBound
        while index < limit {
            let end = lineEnd(from: index, limit: limit)
            let line = word(index, min(end, index + 12))
            if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff ") || line.hasPrefix("index ")
                || line.hasPrefix("new file") || line.hasPrefix("deleted file") || line.hasPrefix("similarity")
                || line.hasPrefix("rename ") || line.hasPrefix("Binary") {
                emit(index, end, .keyword)
            } else if line.hasPrefix("@@") {
                emit(index, end, .meta)
            } else if line.hasPrefix("+") {
                emit(index, end, .addition)
            } else if line.hasPrefix("-") {
                emit(index, end, .deletion)
            }
            index = min(end + 1, limit)
        }
    }
}

// MARK: - Words

private enum Words {
    static func set(_ words: String) -> Set<String> { Set(words.split(separator: " ").map(String.init)) }

    static let c = set("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr _Bool")
    static let cTypes = set("size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t intptr_t ptrdiff_t FILE")
    static let cpp = set("alignas alignof and asm catch class concept consteval constexpr constinit co_await co_return co_yield decltype delete explicit export friend mutable namespace new noexcept not operator or override final private protected public requires static_assert static_cast dynamic_cast reinterpret_cast const_cast template this thread_local throw try typeid typename using virtual xor std string vector")
    static let objectiveC = set("id self super nil Nil YES NO SEL IMP BOOL instancetype nonatomic atomic strong weak copy assign readonly readwrite nullable nonnull")
    static let csharp = set("abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in init int interface internal is lock long namespace new null object operator out override params partial private protected public readonly record ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using value var virtual void volatile when where while with yield")
    static let java = set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new null package permits private protected public record return sealed short static strictfp super switch synchronized this throw throws transient true false try var void volatile while yield")
    static let groovy = set("def as in it trait")
    static let kotlin = set("abstract actual annotation as break by catch class companion const constructor continue crossinline data do dynamic else enum expect external false field final finally for fun get if import in infix init inline inner interface internal is it lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend tailrec this throw true try typealias typeof val value var vararg when where while")
    static let scala = set("abstract case catch class def do else enum extends export false final finally for forSome given if implicit import lazy match new null object override package private protected return sealed super then this throw trait true try type using val var while with yield")
    static let swift = set("actor any as associatedtype async await borrowing break case catch class consuming continue convenience default defer deinit didSet do dynamic else enum extension fallthrough false fileprivate final for func get guard if import in indirect infix init inout internal is isolated lazy let macro mutating nil nonisolated nonmutating open operator optional override package postfix precedencegroup prefix private protocol public repeat required rethrows return self Self set some static struct subscript super switch throw throws true try typealias unowned var weak where while willSet")
    static let go = set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr make new len cap append copy delete panic recover")
    static let rust = set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type union unsafe use where while i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Some None Result Ok Err Box")
    static let javascript = set("abstract any as asserts async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of override package private protected public readonly return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield")
    static let dart = set("abstract as assert async await base break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null on operator part required rethrow return sealed set show static super switch sync this throw true try typedef var void when while with yield int double num String bool List Map Set Future Stream")
    static let php = set("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait true false try unset use var while xor yield self parent")
    static let zig = set("addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while true false null undefined void bool type u8 u16 u32 u64 usize i8 i16 i32 i64 isize f32 f64")
    static let solidity = set("abstract address anonymous as assembly bool break bytes calldata catch constant constructor continue contract delete do else emit enum event external fallback false for function if immutable import indexed interface internal is library mapping memory modifier new override payable pragma private public pure receive return returns revert storage string struct true try type uint uint256 int int256 unchecked using view virtual while")
    static let protobuf = set("syntax package import option message enum service rpc returns repeated optional required oneof map reserved extend stream true false double float int32 int64 uint32 uint64 sint32 sint64 fixed32 fixed64 sfixed32 sfixed64 bool string bytes")
    static let graphql = set("query mutation subscription fragment on type interface union enum scalar input extend schema directive implements true false null")
    static let python = set("and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return self True try type while with yield")
    static let pythonTypes = set("int float str bytes bool list dict set tuple object type None print len range")
    static let ruby = set("BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer private protected public puts")
    static let shell = set("if then else elif fi case esac for select while until do done in function time coproc return exit break continue local export readonly declare typeset unset shift source alias set eval exec trap echo printf cd test true false")
    static let powershell = set("begin break catch class continue data define do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow")
    static let perl = set("my our local sub if elsif else unless while until for foreach do last next redo return use require package BEGIN END and or not eq ne lt gt le ge cmp print")
    static let r = set("if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA library require return")
    static let elixir = set("after alias and case catch cond def defdelegate defexception defguard defimpl defmacro defmodule defp defprotocol defstruct do else end false fn for if import in nil not or quote raise receive require rescue true try unless unquote use when with")
    static let julia = set("abstract baremodule begin break catch const continue do else elseif end export false finally for function global if import in let local macro module mutable quote return struct true try type using where while")
    static let yaml = set("true false null yes no on off True False Null Yes No On Off TRUE FALSE NULL")
    static let dockerfile = set("from as run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell")
    static let makefile = set("ifeq ifneq ifdef ifndef else endif include define endef export override vpath")
    static let cmake = set("if else elseif endif foreach endforeach while endwhile function endfunction macro endmacro set unset option project add_executable add_library target_link_libraries target_include_directories find_package include return message cmake_minimum_required")
    static let terraform = set("resource data variable output locals module provider terraform for_each count depends_on lifecycle dynamic true false null for in if")
    static let nix = set("let in with rec inherit if then else assert import true false null or")
    static let sql = set("add all alter and any as asc begin between by case cascade check column commit constraint create cross database default delete desc distinct drop else end except exists false foreign from full group having if in index inner insert intersect into is join key left like limit not null offset on or order outer primary references replace returning right rollback select set table then to transaction true truncate union unique update using values view when where with")
    static let sqlTypes = set("int integer bigint smallint serial bigserial decimal numeric real float double varchar char text boolean bool date time timestamp timestamptz interval json jsonb uuid blob bytea")
    static let lua = set("and break do else elseif end false for function goto if in local nil not or repeat return then true until while self")
    static let haskell = set("case class data default deriving do else family forall foreign if import in infix infixl infixr instance let module newtype of then type where qualified as hiding")
    static let erlang = set("after and andalso band begin bnot bor bsl bsr bxor case catch cond div end fun if let not of or orelse receive rem try when xor module export import define record")
    static let lisp = set("defun defmacro defvar defparameter defn defn- def let let* lambda fn if when unless cond case and or not progn loop do quote setq setf require ns import")
    static let css = set("important inherit initial unset revert none auto")
}
