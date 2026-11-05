# `untangle reduce-complexity` — ein Loop zur Komplexitätsreduktion bei gleicher Fähigkeitsabdeckung

Entwurf, 2026-09-08. Status: **Design abgenommen, nicht gebaut.**

Schließt `B30` (funktionale Äquivalenz), `B31` (Komplexitäts-Ratsche) und `B39`
(nachvollziehbare Kette von Absicht über Änderung und Verifier zu strukturellem
Vorher/Nachher) zusammen. Bauplan-Bezug: WP-90, WP-91, WP-105, WP-107.

---

## 1. Zweck

Ein Agent soll Untangle strukturiert nutzen können, um **Komplexität zu senken, ohne
Funktionsumfang zu verlieren**. Untangle misst, schlägt vor und urteilt; die Änderung macht
der Agent.

Der Loop verbindet drei Achsen, die heute getrennt existieren:

- **semantisch** — Embeddings der AST-Chunks, geclustert zu Fähigkeiten;
- **ontologisch** — Symbolgraph, Dateigraph, eigene Metriken;
- **operational** — Tests, externe Befunde und Messwerte (Sonar, sentrux).

## 2. Getroffene Entscheidungen

| # | Entscheidung | Begründung |
|---|---|---|
| L1 | „Gleicher Funktionsumfang" wird **semantisch über Cluster** gemessen, nicht über die öffentliche Symboloberfläche. | Der wertvollste Refactor — drei fast gleiche Implementierungen zu einer — ändert die Signaturen. Eine Oberflächenprüfung nach WP-90 würde genau das blockieren, was das Ziel ist. |
| L2 | Eine Fähigkeit heißt nach ihrem **Medoid-Symbol**, ihre Geometrie ist der **Zentroid**. | Verbindet die drei Achsen an einem Punkt: der semantische Anker ist zugleich ein Objekt im Symbolgraphen, an dem Tests und Befunde hängen. Überlebt Umbenennen und Verschieben. |
| L3 | **Abdeckungsverlust sperrt**, gestiegene Komplexität bei erhaltener Abdeckung sperrt ebenso. Komplexität ist das Ziel, nicht das Gate für Funktionalität. | Ohne Sperre erzwingt nichts die gleiche Fähigkeitszahl; ein Agent könnte Funktionalität wegoptimieren, solange die Tests es nicht merken. |
| L4 | Ein **Paket** `packages/capability-map` mit den Modulen `map` und `ratchet`, statt der im Bauplan vorgesehenen Trennung `packages/change-engine`. | Die Ratsche hat ohne die Fähigkeitskarte keinen Gegenstand. Zwei Pakete wären hier eine Grenze, die man bei jedem Aufruf überquert. Bewusste Abweichung von WP-90. |
| L5 | **Keine Patch-Erzeugung, kein Auto-Refactoring.** | Patches zu erzeugen verlangt Sprachsemantik, die Untangle bewusst nicht hat. Es sagt wo und warum. |
| L6 | Eine gesunkene **Testzahl sperrt nicht, muss aber deklariert sein**; undeklariert gesunken sperrt. | WP-90 verlangt „kein Test entfernt". Das verhindert den wertvollsten Refactor, der doppelte Tests zu Recht entfernt. Stillschweigen ließe Funktionalität verschwinden. Deklaration ist die Mitte, die die Spur ehrlich hält. |
| L7 | Untangle **führt keine Tests aus**, sondern liest einen JUnit-XML-Bericht des Aufrufers. | Wie ein Projekt seine Tests startet, ist Werkzeugwissen (dieselbe Linie wie L5 und X9). Der Parser existiert bereits. Fehlt der Bericht, sperrt die Teststufe mit diesem Grund, statt sie zu überspringen. |
| L8 | Neue **Zyklen** werden gegen Symbol- **und** Dateigraph der neuen Generation geprüft, nicht nur gegen einen von beiden. | Ein Zyklus, der auf Dateiebene entsteht, aber auf Symbolebene nicht sichtbar ist, ist trotzdem einer — und umgekehrt. |

## 3. Der Loop

Fünf Verben, eine persistierte Sitzung. Die Reihenfolge ist die Aussage: **Absicht vor
Änderung, Änderung vor Urteil.**

```text
untangle reduce-complexity start   [--scope <glob>] [--goal <text>]
untangle reduce-complexity propose <sessionId> [--limit <n>]
untangle reduce-complexity select  <sessionId> --capability <id>
        … der Agent ändert Code und reindiziert …
untangle reduce-complexity verify  <sessionId> --test-report <pfad>
                                   [--removed-tests <grund>]
untangle reduce-complexity report  <sessionId>
untangle reduce-complexity abandon <sessionId> --reason <code>
```

`select` ist der Grund, warum das eine Kette ist und keine vier Aufrufe: der Agent legt sich
**vor** der Änderung auf ein Ziel fest. Ohne diesen Schritt ließe sich das Ziel hinterher
passend zum Ergebnis wählen, und die Kette bewiese nichts.

**Zustände:** `open → proposed → selected → verified → closed`, dazu `abandoned` aus jedem
Zustand. Übergänge sind einseitig; ein zweites `select` in derselben Sitzung wird abgelehnt.

**Persistenz** erbt die Search-Journey-Maschinerie aus Welle 9: atomar geschrieben, Modus
`0600`, je Record auf 32 MiB und je Store auf 10.000 Records begrenzt, mit der
Accepted-Attempt-Integrität, die dort bereits adversarial geprüft wurde. Keine zweite
Persistenzschicht.

**Baseline-Bindung.** `start` heftet die Sitzung an Repo, Ref, Generation und den vollständigen
Korpusfingerprint. `verify` verlangt eine **neue** Generation und lehnt fail-closed ab, wenn

- die Korpusbindung unvollständig ist,
- das Embedding-Profil oder die Indexgeneration nicht mehr vergleichbar ist,
- oder die Generation dieselbe ist wie zur Baseline (dann wurde nichts reindiziert).

## 4. Die Fähigkeitskarte

### 4.1 Aufbau

1. **Symbolzentroide.** Je Symbol der Mittelwert der Vektoren seiner Chunks. Chunks ohne
   `symbolId` und Symbole ohne Chunk gehen nicht ein und stehen mit Grund im Skip-Ledger.
2. **Nachbarschaft.** Je Symbolzentroid eine k-NN-Abfrage gegen den Store, `k = 32`.
   Paarweiser Vergleich aller Symbole scheidet aus: ~9.000 Symbole ergeben ~40 Mio.
   Cosinus-Berechnungen auf 768 Dimensionen.
3. **Graph und Komponenten.** Eine Kante entsteht nur bei **Gegenseitigkeit** — beide Symbole
   führen einander in ihren k nächsten Nachbarn — und oberhalb der Cosinus-Schwelle
   `edgeThreshold`. Die Zusammenhangskomponenten dieses Graphen sind die Fähigkeiten.
4. **Anker.** Medoid ist das Mitgliedssymbol mit dem geringsten Abstand zum Komponenten-
   zentroid. Bei Gleichstand entscheidet die Codepoint-Ordnung des FQN.

### 4.2 Der bekannte Schwachpunkt

Zusammenhangskomponenten **ketten**: A ähnelt B, B ähnelt C, und die Komponente wächst über
Grenzen hinweg, die niemand gezogen hat. Gegenseitigkeit und Schwelle dämpfen das stark,
schließen es aber nicht aus.

Deshalb gibt jede Karte die **Größenverteilung ihrer Komponenten** aus (Anzahl, Median, p90,
Maximum, Anteil des größten Clusters am Korpus). Eine verkettete Karte ist damit sichtbar,
statt still die halbe Analyse zu sein. Überschreitet der größte Cluster `maxClusterShare` des
Korpus, trägt die Karte `chained: true` und jedes darauf gestützte Urteil den entsprechenden
Caveat.

### 4.3 Determinismus

Die ANN-Suche ist approximativ; zwei Neuberechnungen können abweichen. Die Karte wird deshalb
**einmal je Generation berechnet und als Artefakt persistiert**, gebunden an Generation und
Korpusfingerprint. Zwei `verify`-Läufe gegen dieselbe Generation lesen dieselbe Karte.

Determinismus gilt damit für das **Artefakt**, nicht für die Wiederberechnung. Das steht so in
der Ausgabe; es als Reproduzierbarkeit der Berechnung auszugeben wäre falsch.

### 4.4 Inhalt je Fähigkeit

| Achse | Felder |
|---|---|
| semantisch | `centroid`, `memberSymbolIds`, `cohesion` (mittlerer Cosinus zum Zentroid) |
| ontologisch | `symbols`, `files`, `inDegree`, `outDegree`, `maxDepth`, `cyclesTouched` |
| operational | `testIds` (Tests, die Mitgliedssymbole ausführen), `externalFindingIds`, `externalMeasurementKeys` |
| Kosten | `cognitive`, `cyclomaticClassic`, `cyclomaticExtended`, `sloc`, alle `untangle-metrics-v1` |

### 4.5 Wiederfinden

Beim Vergleich zweier Karten gilt eine Baseline-Fähigkeit als wiedergefunden, wenn

1. ihr **Medoid-Symbol** in der neuen Karte existiert und Mitglied genau einer Fähigkeit ist
   (schneller Weg), **oder**
2. eine neue Fähigkeit existiert, deren Zentroid einen Cosinus ≥ `matchThreshold` zum
   Baseline-Zentroid hat und die nicht bereits einer anderen Baseline-Fähigkeit zugeordnet
   wurde (geometrischer Weg; Zuordnung greedy in absteigender Ähnlichkeit, deterministisch
   über die Codepoint-Ordnung der Baseline-IDs).

Trifft keines zu, gilt die Fähigkeit als **verloren** und wird mit Namen, letztem bekanntem
Medoid und bestem erreichten Cosinus ausgewiesen.

### 4.6 Skip-Ledger (E4)

Jeder nicht eingegangene Gegenstand steht mit Grund in der Karte: Symbole ohne Embedding,
Chunks ohne `symbolId`, durch `--scope` ausgeschlossene Dateien, Dateien im Skip-Ledger des
Index. Eine Fähigkeitskarte, die schweigend einen Teil des Repositoriums auslässt, wäre die
gefährlichste Fassung dieses Werkzeugs.

## 5. `propose` — Kandidaten

Vier Signale, je Kandidat genannt. Keines verspricht eine Zahl.

| Signal | Bedingung | Empfohlene Richtung |
|---|---|---|
| `redundancy` | Zentroid-Cosinus zweier Fähigkeiten ≥ `redundancyThreshold` | zusammenlegen |
| `cost_density` | `cognitive` je Mitgliedssymbol ≥ `densityFactor` × Median des Korpus | vereinfachen |
| `low_cohesion` | `cohesion` ≤ `cohesionFloor` **und** Kosten über dem Median | teilen |
| `corroborated` | externe Befunde an Mitgliedssymbolen vorhanden | erhöht die Zuversicht |

`corroborated` ist **kein eigener Kandidatentyp**, sondern ein Sortierzuschlag auf die anderen
drei. Externe Befunde gehen in keine Zahl ein (X3); sie ordnen nur.

Ausgabe je Kandidat: Fähigkeits-ID, Medoid, Zielsymbole, aktuelle Kosten, Signal, Begründung
im Klartext, Richtung. **Nicht** ausgegeben wird eine erwartete Ersparnis — sie wäre geraten.

## 6. `verify` — das Urteil

Die Reihenfolge ist bindend. Jede Stufe läuft nur, wenn die vorherige bestanden ist.

```text
1. Vorbedingungen (fail-closed)
     Korpusbindung vollständig · neue Generation · gleiches Embedding-Profil
     Testbericht vorhanden und ohne failure/error
     keine neuen Zyklen im Symbol- und Dateigraphen der neuen Generation
2. Abdeckung (sperrt)
     jede Baseline-Fähigkeit nach §4.5 wiedergefunden?
3. Ziel (sperrt)
     cognitive über den Korpus nicht gestiegen?
4. Verbesserung (berichtet)
     QualityImprovementV1 mit Beitragsstellen (Datei, Symbol, Konstrukt)
```

**Woher die Testergebnisse kommen (L7).** Untangle **führt die Tests nicht aus**. Es liest einen
Bericht im JUnit-XML-Format, den der Aufrufer über `--test-report <pfad>` übergibt; der Parser
dafür steht bereits in `packages/extension-runtime`. Der Grund ist derselbe wie bei L5: wie ein
fremdes Projekt seine Tests startet, ist Werkzeugwissen, das Untangle nicht hat und nicht raten
soll. `start` liest denselben Bericht für die Baseline; fehlt er bei `start`, kann `verify` die
Teststufe nicht prüfen und sperrt mit diesem Grund, statt sie stillschweigend zu überspringen.

**Tests (L6).** Alle müssen grün sein — kein `failure`, kein `error` im Bericht. Eine gesunkene
Testzahl gegenüber der Baseline sperrt nur, wenn sie nicht über `--removed-tests <grund>`
deklariert wurde; die Deklaration landet in der Spur.

**Caveats.** Jedes Urteil trägt mit: die Abdeckung ist eine Clustering-Heuristik an benannten
Schwellen; `chained: true` der zugrunde liegenden Karte erscheint im Urteil; ein `blocked`
wegen verlorener Abdeckung nennt immer die konkrete Fähigkeit.

## 7. Datenverträge

Alle mit `schemaVersion` (B25), alle in `@untangle-code/domain`:

- `CapabilityV1` — eine Fähigkeit nach §4.4.
- `CapabilityMapV1` — Fähigkeiten, Komponentenverteilung, `chained`, Schwellen, Skip-Ledger,
  Bindung an Generation und Korpusfingerprint.
- `ReduceComplexitySessionV1` — Zustand, Baseline-Bindung, Kandidaten, gewähltes Ziel,
  Änderungsbezug, Urteil.
- `RatchetVerdictV1` — `verdict: "passed" | "blocked"`, Teilurteile je Stufe, Caveats.
- `QualityImprovementV1` — Senkung mit Beitragsstellen (WP-91).

## 8. Fehlerbehandlung

- Unvollständige oder inkompatible Bindung ⇒ fail-closed, kein Urteil.
- Fehlender Store, fehlende Generation, fehlende Metriken ⇒ `FEATURE_UNAVAILABLE` mit Grund;
  sichtbare Degradation statt stiller Teilkarte.
- Jede Phase ist über `AbortSignal` abbrechbar (spec.md §22); ein Abbruch hinterlässt die
  Sitzung im letzten gültigen Zustand.
- Externe Signale fehlen ⇒ `corroborated` entfällt, die übrigen Signale bleiben gültig.

## 9. Tests

- **Goldene Karte** auf einem Fixture-Korpus mit bekannten Duplikaten; Zentroide und
  Zuordnungen bytegleich gegen die Golden-Datei.
- **Mutationsprobe je Gate.** Ein Lauf, der eine Fähigkeit verliert, *muss* fehlschlagen; ein
  Lauf, der cognitive erhöht, ebenso. Ein Gate, das nicht nachweislich sperrt, ist Dekoration.
- **Kettenbildung** (§4.2) als eigener Test: ein konstruierter Korpus mit einer Ähnlichkeits-
  kette erzeugt `chained: true` und den Caveat im Urteil.
- **Testzahl-Regel** (L6): undeklarierte Senkung sperrt, deklarierte nicht.
- **Fehlender Testbericht** (L7): `verify` sperrt mit genanntem Grund statt die Stufe zu
  überspringen; ein Bericht mit `failure` oder `error` sperrt ebenso.
- **Abbruch** je Phase.
- **Wiederfinden** (§4.5): Umbenennen des Medoids, Verschieben in eine andere Datei,
  Zusammenlegen zweier Fähigkeiten — jeweils mit erwartetem Urteil.

## 10. Was der Loop ausdrücklich nicht behauptet

Er misst Struktur und Ähnlichkeit. Er beweist **nicht**, dass sich das Verhalten nicht geändert
hat — dafür stehen die Tests, und die prüfen, was sie prüfen. Die Aussage lautet „weniger
Komplexität bei erhaltener Fähigkeitsabdeckung", nicht „dasselbe Programm".

Ebenso wenig ist eine Fähigkeit ein Feature im Produktsinn. Sie ist ein Cluster ähnlicher
Symbole. Die Verbindung zu vom Caller deklarierten Feature-IDs (B38) bleibt eine getrennte
Evidenzbahn und wird hier nicht vermischt.

## 11. Kalibrierung

Die Schwellen sind Startwerte und werden an diesem Repositorium kalibriert. Die Kalibrierung
ist Teil der Umsetzung, nicht Nacharbeit.

| Schwelle | Startwert | Abnahmekriterium der Kalibrierung |
|---|---:|---|
| `edgeThreshold` | 0,82 | größter Cluster < `maxClusterShare`; Median-Clustergröße 3–30 Symbole |
| `matchThreshold` | 0,90 | ein reines Umbenennen findet 100 % wieder; ein echtes Entfernen 0 % |
| `redundancyThreshold` | 0,95 | die bekannten Duplikate des Repos erscheinen, offensichtlich Verschiedenes nicht |
| `densityFactor` | 3,0 | die Kandidatenliste bei `--limit 20` enthält keinen Treffer, den eine manuelle Sichtung verwirft |
| `cohesionFloor` | 0,60 | trennt die bekannten Sammelmodule des Repos von den fokussierten; kein fokussiertes Modul fällt darunter |
| `maxClusterShare` | 0,15 | bei `edgeThreshold` 0,82 auf diesem Repo nicht erreicht; wird er erreicht, ist die Schwelle zu niedrig und nicht der Anteil zu hoch |

Jede Schwelle steht in der Ausgabe der Karte; ein Urteil ohne die Schwellen, unter denen es
zustande kam, wäre nicht nachprüfbar.

## 12. Abweichungen vom Bauplan

- **WP-90** sah `packages/change-engine` und funktionale Äquivalenz über die Symboloberfläche
  vor. Ersetzt durch L1 und L4, Begründung dort.
- **WP-91** bleibt inhaltlich gültig; die Ratsche prüft jetzt gegen die Fähigkeitsabdeckung
  statt gegen die Oberfläche.
- **WP-107** ist berührt, aber nicht Teil dieses Entwurfs: der `RiskScoreV1` bleibt eine
  gewichtete Summe und damit kompensierbar. Der Loop benutzt ihn nicht.
