# RCLLR-39: Rückfragen bei sensiblen Hub-Zugriffen

Stand: 10.11.2026. Nur Analyse, kein Fix.

## Empfehlung

1. **Sofort, im Hub (kein rcllr-Code):** Den Abschnitt „Git und generierte Indizes" in `~/claude-hub/AGENTS.md`
   und `CLAUDE.md` auf den Stand des rcllr-Templates bringen. Er schreibt heute manuelles `git fetch`,
   `git merge`, `git commit` und `git push` vor. `ingest` und `write` erledigen das selbst. Damit fallen die
   Ketten weg.
2. **In rcllr (Idee a, richtig gebaut):** Ein `UserPromptSubmit`-Hook leitet die Freigabe aus dem echten
   Nutzerprompt ab. Ein `PreToolUse`-Hook gibt `--allow-sensitive`-Aufrufe frei, die diese Freigabe abdeckt.
   Alles andere fragt weiter, jetzt per Hook. Die `ask`-Regel muss dafür raus, denn ein Hook-`allow` hebt sie
   nicht auf. Headless und ohne Prompt-Treffer scheitert der Aufruf weiter.
3. **Idee b nicht bauen.** `ingest` und `write` fetchen, rebasen, committen und pushen schon, unter einer
   Prozesssperre.
4. **Idee c löst nichts.** Die Session lief bereits im Auto-Mode und hat trotzdem gefragt.

## Befund (geprüft)

- `~/claude-hub/.claude/settings.json`: `allow` für `Bash(rcllr *)`, `dummkopf`, `dk`; `ask` für
  `Bash(rcllr *--allow-sensitive*)` und die zwei alten Namen. `settings.local.json` ändert daran nichts.
- Commit `ee33f7b` (23.10.2026, „Rename to rcllr") hat `allow` und `ask` gemeinsam eingeführt.
- Die Regeln stammen nicht aus Handarbeit: `rcllr install` schreibt sie (`packages/core/src/install.ts`,
  `PERMISSIONS`). Der Kommentar dort nennt den Zweck: Headless-Agenten dürfen rcllr aufrufen, sensible Notizen
  aber nie öffnen. Test: `packages/core/test/admin-install.test.ts` („asks before sensitive reads").
- README „Headless agents" sagt selbst: Die Regeln sind keine Sicherheitsgrenze. Ein Agent kann die Dateien
  mit `cat` lesen. Der Hub hat keine `deny`-Regel für sensible Pfade.
- Session `5b5eded3` vom 10.11.2026 im Hub: Permission-Mode `auto`. 14 Bash-Aufrufe mit `--allow-sensitive`,
  jeder davon löste eine Rückfrage aus. 4 lehnte der User ab.
- Die Ketten stammen aus `~/claude-hub/AGENTS.md` Zeile 139-141: „Jede Notizänderung direkt nach der Antwort
  committen und pushen. Vor Änderungen den Remote-Stand holen", dazu die `git fetch`/`git merge`-Befehle.
  Der Hub-Skill (`personal:hub`) sagt das Gegenteil: „Index, Commit und Push erledigt die CLI. Kein eigenes git."
- Das rcllr-Template (`packages/core/src/scaffold.ts`, `SYNC_REMOTE`) ist korrekt. Die Hub-`AGENTS.md` ist
  eine ältere Handfassung und weicht ab.
- `ingest` ruft `prepareRepository` (Fetch, Rebase) vor dem Schreiben und `syncLocked` (Commit, Push mit drei
  Versuchen) danach auf, beides unter `withRepositoryLock` (`packages/core/src/write.ts`, `sync.ts`).
- Ein Aufruf nutzte `--allow-sensitive "wärmepumpe"`, also einen Suchbegriff statt Pfad. rcllr antwortete mit
  „Path unavailable or access excluded". Grants verlangen einen Pfad unter `topics/` oder eine `.md`-Datei
  (`Access.grant`).

## Threat-Model

Ziel-Threat-Model laut `SECURITY.md` und README:

- rcllr verteidigt gegen ein fremdes, feindliches Brain (Symlinks, Schreibweisen, Konfiguration).
- rcllr verteidigt nicht gegen jemanden, der Notizen ändern kann und sie dann mit `--allow-sensitive` liest.
- Der Permission-Dialog ist ausdrücklich keine Grenze. Er schützt vor zwei Dingen:
  - einem Agenten, der sensible Themen ohne Nennung im aktuellen Prompt öffnet (Fehlverhalten oder
    Prompt-Injection aus Notizinhalten), sichtbar für jemanden, der über die Schulter schaut;
  - Headless-Läufen, in denen niemand ein Thema nennen kann.

Jede Lösung muss beide Fälle mindestens so gut abdecken wie heute. Die Regel aus `AGENTS.md` („nur nach
Nennung im aktuellen Prompt") prüft heute nur das Modell selbst. Der Dialog ist die einzige Prüfung von außen.

## Bewertung der Ideen

### a) `ask` streichen, Freigabe in rcllr durchsetzen

Ein Befehl wie `rcllr grant <thema> --ttl 2h` bringt nichts: Den kann der Agent selbst aufrufen. Er ersetzt
das Flag eins zu eins und verliert die Prüfung von außen.

Tragfähig ist nur ein Kanal, den der Agent nicht schreibt: der Nutzerprompt. Claude Code übergibt ihn dem
`UserPromptSubmit`-Hook.

- Sicherheit: gleich oder besser als heute, wenn der Hook nur echte Prompt-Treffer freigibt und alles andere
  bei `ask` bleibt. Restrisiko: Der Agent kann die Grant-Datei per Shell schreiben. Das liegt in derselben
  Klasse wie `cat` und damit außerhalb des Threat-Models. Die Datei gehört nach `.git/` (nie committet).
- Bonus: Die Regel „nur nach Nennung im aktuellen Prompt" prüft dann Code, nicht nur das Modell.
- Aufwand: mittel. Neue Hook-Befehle, Grant-Speicher, Abgleich Prompt gegen Themen, Install-Änderung, Tests.
- Abgleich-Risiko: Der User nennt das Thema anders als den Ordner („Wärmepumpe" statt `haus-ulm`). Treffer
  über Ordnername und `aliase` aus dem Topic-README. Kein Treffer heißt: Rückfrage wie heute.

### b) Ein Befehl für Fetch, Merge, Ingest, Commit, Push

Existiert schon: `ingest` und `write`. Die Ketten entstehen nur, weil die Hub-`AGENTS.md` veraltet ist.
Aufwand: eine Doku-Korrektur im Hub. Sicherheit: neutral. Die Ketten mit `$(rcllr read …)` für die Revision
fallen damit nicht ganz weg; der Skill zeigt dafür schon `read` als Einzelaufruf.

### c) Auto-Mode bewertet Ketten anders

Die Session lief im Auto-Mode und fragte bei jedem `--allow-sensitive`. Explizite `ask`-Regeln gelten also
auch dort (geprüft am Transkript). Details zur Doku siehe unten.

Doku-Fakten (Claude Code, code.claude.com, 10.11.2026 gelesen):

- Ketten: Claude Code trennt an `&&`, `||`, `;`, `|`, `|&`, `&` und Zeilenumbrüchen. Jeder Teilbefehl braucht
  eine eigene Freigabe. `Bash(rcllr *)` deckt `git fetch && rcllr ingest` nicht ab (permissions, „Compound
  commands").
- `ask` und `deny` greifen, sobald ein Teilbefehl passt, auch in Subshells und `$(…)`.
- Reihenfolge: deny, dann ask, dann allow. „Nicht mehr fragen" im Dialog legt eine `allow`-Regel an; die
  `ask`-Regel gewinnt trotzdem (abgeleitet aus der Reihenfolge, nicht getestet).
- Auto-Mode: „Explicit ask rules still force a prompt." Breite Regeln wie `Bash(*)` entfernt der Auto-Mode;
  `Bash(rcllr *)` steht nicht auf der Liste.
- Headless (`claude -p`): Aufrufe, die eine Freigabe brauchen, lehnt Claude Code ab. Für `ask`-Treffer steht
  das nicht wörtlich da (ungeprüft, aber README und Install-Kommentar gehen davon aus).
- Hooks: Ein `PreToolUse`-`allow` hebt eine passende `ask`-Regel **nicht** auf („a matching ask rule still
  prompts even when the hook returned allow"). `UserPromptSubmit` erhält `prompt` und `session_id`,
  `PreToolUse` erhält `session_id`.

Folge für Idee a: Der Hook-Weg funktioniert nur ohne die `ask`-Regel. Der `PreToolUse`-Hook muss die
Rückfrage selbst auslösen (`permissionDecision: "ask"`), wenn kein Grant passt.

## Umsetzungsplan (Empfehlung 2)

Dateien in rcllr:

- `packages/core/src/grants.ts` (neu): Grants lesen, schreiben, ablaufen lassen. Speicher
  `.git/rcllr/grants.json`, Schlüssel `session_id`, Eintrag Pfad plus Ablaufzeit.
- `packages/core/src/hook.ts`: `hook prompt` (UserPromptSubmit) gleicht Prompt-Wörter gegen sensible
  Topic-Ordner und deren `aliase` ab und schreibt Grants. `hook pretool` (PreToolUse, Matcher `Bash`) zerlegt
  den Befehl, sammelt `--allow-sensitive`-Pfade und antwortet `allow`, wenn alle gedeckt sind, sonst `ask`.
- `packages/core/src/install.ts`: beide Hooks eintragen und die `ask`-Regeln für `--allow-sensitive`
  entfernen. Ein Hook-`allow` schlägt `ask` nicht (siehe Doku-Fakten). Ohne Grant antwortet der Hook `ask`.
  Brains ohne neues `install` behalten die alte Regel.
- `packages/core/templates/AGENTS.md`, README „Headless agents", `CHANGELOG.md`.

Tests zuerst (TDD), Randfälle:

- Prompt nennt Thema per Ordnername, per Alias, in anderer Groß-/Kleinschreibung, mit Umlaut.
- Prompt nennt kein Thema: kein Grant, Aufruf fragt.
- Grant deckt `topics/x/`, Aufruf will `topics/y/`: fragt.
- Grant abgelaufen, andere `session_id`, kaputte oder fremde Grant-Datei, Symlink als Grant-Datei: fragt.
- Kette `git fetch && rcllr read … --allow-sensitive topics/x/`: Hook findet den Pfad auch in Ketten.
- `--allow-sensitive=…`-Schreibweise, Anführungszeichen, `$(…)`.
- Headless ohne Prompt-Treffer: Hook antwortet `ask` bzw. `deny`, Aufruf scheitert wie heute.
- `install` entfernt genau die eigenen `ask`-Regeln, fremde bleiben (Erweiterung von `admin-install.test.ts`).

Im Hub, unabhängig davon:

- `AGENTS.md`/`CLAUDE.md` Abschnitt „Git und generierte Indizes" durch den Text von `rcllr install` ersetzen
  (oder `AGENTS.md` neu generieren lassen, falls rcllr das anbietet; ungeprüft).
- Nach dem Release `rcllr install` erneut laufen lassen.
