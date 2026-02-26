DEFINE
    VAR Zeitfilter =
        FILTER(
            KEEPFILTERS(VALUES('Zeitachse'[Datum])),
            AND(
                'Zeitachse'[Datum] >= DATE(2025, 11, 18),
                'Zeitachse'[Datum] < (DATE(2025, 11, 18) + TIME(0, 0, 1))
            )
        )
 
    VAR Result =
        SUMMARIZECOLUMNS(
            'Zeitachse'[Datum],
            'Betriebe'[Betriebscode],
            'Betriebe'[Betrieb],
            Zeitfilter,
            "Umsatz_Restaurant", 'Einnahmen'[Umsatz Restaurant],
            "Umsatz_Catering", 'Einnahmen'[Umsatz Catering],
            "Umsatz_Total", 'Einnahmen'[Umsatz Total]
        )
 
EVALUATE
    Result
 
ORDER BY
    'Zeitachse'[Datum], 'Betriebe'[Betriebscode], 'Betriebe'[Betrieb]