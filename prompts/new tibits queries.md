QUERY 1:

Notes:

Effektiver Umsatz pro Tag, pro Kostenstelle			
Welcher Umsatz wurde effektiv pro Kostenstelle erzielt?			
			
Datum	KST	Wert	
2025-01-01	200100	2342.32	immer nur letze 14 Tage
			
		Muss dynamisch eingegeben werden	
"Umsatz_Restaurant" ersetzen mit:
Forecast Umsatz

Sample Query:

DEFINE
VAR __DS0FilterTable =
FILTER(
KEEPFILTERS(VALUES('Zeitachse'[Datum])),
AND('Zeitachse'[Datum] >= DATE(2025, 12, 29), 'Zeitachse'[Datum] < DATE(2026, 1, 12))
)

VAR __DS0FilterTable2 =
TREATAS({"aktiv"}, 'Betriebe'[Status])

VAR __DS0FilterTable3 =
FILTER(
KEEPFILTERS(VALUES('Betriebe'[Betrieb])),
NOT(
Betriebe'[Betrieb] IN {BLANK(),
"tibits Backoffice",
"tibits Event",
"ZFF",
"SIB",
"Pride",
"tibits Webladung",
"tibits Darmstadt",
"Sonnenberg"}
)
)

VAR __DS0Core =
SUMMARIZECOLUMNS(
Zeitachse'[Datum],
Betriebe'[Standort],
Betriebe'[Betriebscode],
__DS0FilterTable,
__DS0FilterTable2,
__DS0FilterTable3,
"Umsatz_Restaurant", 'Einnahmen'[Umsatz Restaurant]
)

EVALUATE
__DS0Core

ORDER BY
Zeitachse'[Datum], 'Betriebe'[Standort], 'Betriebe'[Betriebscode]

----

More Notes:
Forecast Umsatz pro Tag, pro Kostenstelle					
Welcher Umatz wird für eine Kostenstelle erwartet?					
					
Datum	KST	Wert			
2025-01-01	200100	2342.32			Forecast Umsatz
					
					
Budget Umsatz pro Tag, pro Kostenstelle					
Was sollte eine Kostenstelle an Umsatz erzielen nach Budget?					
					
Datum	KST	Wert			
2025-01-01	200100	2342.32			Budget Umsatz
					
					
Budget Stunden pro Tag, pro Kostenstelle					
Was sollte eine Kostenstelle an Stunden erzielen nach Budget?					

---

QUERY 2:


Datum	KST	Wert			
2025-01-01	200100	235.23			
					
DEFINE					
VAR __DS0FilterTable =					
FILTER(					
KEEPFILTERS(VALUES('Zeitachse'[Datum])),					
AND('Zeitachse'[Datum] >= DATE(2025, 12, 29), 'Zeitachse'[Datum] < DATE(2026, 1, 12))					
)					
					
VAR __DS0FilterTable2 =					
TREATAS({"aktiv"}, 'Betriebe'[Status])					
					
VAR __DS0FilterTable3 =					
FILTER(					
KEEPFILTERS(VALUES('Betriebe'[Betrieb])),					
NOT(					
Betriebe'[Betrieb] IN {BLANK(),					
"tibits Backoffice",					
"tibits Event",					
"ZFF",					
"SIB",					
"Pride",					
"tibits Webladung",					
"tibits Darmstadt",					
"Sonnenberg"}					
)					
)					
					
VAR __DS0PrimaryWindowed =					
SUMMARIZECOLUMNS(					
Zeitachse'[Datum],					
Betriebe'[Standort],					
Betriebe'[Betriebscode],					
Stunde'[Stunde],					
__DS0FilterTable,					
__DS0FilterTable2,					
__DS0FilterTable3,					
"Budget_Umsatz", 'Budget'[Budget Umsatz]					
)					
					
					
					
EVALUATE					
__DS0PrimaryWindowed					
					
ORDER BY					
Zeitachse'[Datum], 'Betriebe'[Standort], 'Betriebe'[Betriebscode], 'Stunde'[Stunde]					