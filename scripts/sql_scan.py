#!/usr/bin/env python3
"""Split a SQL migration into statements for scripts/check-migrations.sh and
scripts/migrate.sh.

Prints one line per statement, lower-cased, with whitespace collapsed:

    top  <statement>    a top-level statement
    do   <statement>    a statement inside the body of a top-level DO block
    meta <text>         a psql backslash command outside any quoted text

Comments are removed, string literals become '' and quoted identifiers "q".
Dollar-quoted bodies become $$ except for DO blocks, whose bodies are scanned
too because they run when the migration runs. Function bodies are not scanned:
defining a function does not execute it.
"""
import re
import sys

DOLLAR_TAG = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


def tokenize(sql):
    """Yield (kind, text) with kind in sql | dollar | meta."""
    i, n = 0, len(sql)
    buf = []
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if c == "-" and nxt == "-":
            j = sql.find("\n", i)
            i = n if j < 0 else j
            buf.append(" ")
        elif c == "/" and nxt == "*":
            depth, i = 1, i + 2
            while i < n and depth:
                if sql.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif sql.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            buf.append(" ")
        elif c == "'":
            escapes = i > 0 and sql[i - 1] in "eE" and (i < 2 or not (sql[i - 2].isalnum() or sql[i - 2] == "_"))
            i += 1
            while i < n:
                if escapes and sql[i] == "\\":
                    i += 2
                elif sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        i += 2
                    else:
                        i += 1
                        break
                else:
                    i += 1
            buf.append("''")
        elif c == '"':
            i += 1
            while i < n:
                if sql[i] == '"':
                    if i + 1 < n and sql[i + 1] == '"':
                        i += 2
                    else:
                        i += 1
                        break
                else:
                    i += 1
            buf.append('"q"')
        elif c == "$" and DOLLAR_TAG.match(sql, i) and not (i > 0 and (sql[i - 1].isalnum() or sql[i - 1] == "_")):
            tag = DOLLAR_TAG.match(sql, i).group(0)
            end = sql.find(tag, i + len(tag))
            body_end = n if end < 0 else end
            yield "sql", "".join(buf)
            buf = []
            yield "dollar", sql[i + len(tag):body_end]
            i = n if end < 0 else end + len(tag)
        elif c == "\\":
            j = sql.find("\n", i)
            j = n if j < 0 else j
            yield "sql", "".join(buf)
            buf = []
            yield "meta", sql[i:j]
            i = j
        else:
            buf.append(c)
            i += 1
    yield "sql", "".join(buf)


def statements(sql):
    """Return [(kind, text)] where kind is top | do | meta."""
    out, current, bodies = [], [], []

    def flush():
        text = " ".join("".join(current).lower().split())
        if text:
            out.append(("top", text))
            if re.match(r"do( |$)", text):
                for body in bodies:
                    for kind, inner in statements(body):
                        out.append(("do" if kind != "meta" else "meta", inner))
        current.clear()
        bodies.clear()

    for kind, text in tokenize(sql):
        if kind == "meta":
            out.append(("meta", " ".join(text.split())))
        elif kind == "dollar":
            current.append(" $$ ")
            bodies.append(text)
        else:
            parts = text.split(";")
            for k, part in enumerate(parts):
                current.append(part)
                if k < len(parts) - 1:
                    flush()
    flush()
    return out


def main():
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as f:
            for kind, text in statements(f.read()):
                print(f"{kind} {text}")


if __name__ == "__main__":
    main()
