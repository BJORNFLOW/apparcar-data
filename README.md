# apparcar-data

Datos públicos de zonas de aparcamiento reguladas, consumidos por
la app **APPARCAR**.

## Contenido

- **`parkingZonesDirect-bcn.json`** — Tramos del Ajuntament de
  Barcelona (~17.000 entradas). Geometría + horario + tarifa + plazas.
  Generado a partir de los datasets oficiales de [Open Data BCN](https://opendata-ajuntament.barcelona.cat/).

## Auto-refresh semanal

Una **GitHub Action** (`.github/workflows/refresh-bcn.yml`) corre
cada lunes 04:00 UTC y:

1. Descarga los CSV oficiales del Ajuntament:
   - trams-aparcament-superficie
   - horaris-aparcaments-superficie
   - tarifes-aparcament-superficie
2. Hace JOIN, traduce horarios catalán → sintaxis OSM, dedup.
3. Si el JSON resultante difiere del anterior, commit automático.

Las apps APPARCAR fetchean este JSON desde la URL raw de GitHub
(con cache 30 días en localStorage del usuario), así que cualquier
cambio del ayto se propaga sin necesidad de nueva release de la APK.

## Trigger manual

GitHub → repo → tab **Actions** → "Refresh BCN parking zones" →
"Run workflow" → main.

## Schema del JSON

Cada entrada del array es:

```json
{
  "i": "7",                              // ID original Ajuntament
  "c": "blue",                           // color de zona
  "l": "Zona Blava (rotación)",          // etiqueta legible
  "h": "Mo-Fr 09:00-20:00",              // horario en sintaxis OSM
  "f": "2,50 euros/hora ...",            // tarifa textual
  "s": "Roger de Flor",                  // calle (sin número)
  "a": "Roger de Flor 79",               // calle + número
  "p": 5,                                // plazas
  "g": [[lng,lat],[lng,lat]]             // geometría (start, end)
}
```

## Licencia datos

Los datos originales son de Open Data BCN bajo CC-BY 4.0. Esta
versión transformada se distribuye bajo la misma licencia.

## Para añadir más ciudades

Cuando otros ayuntamientos publiquen Open Data al nivel de BCN,
crear `parkingZonesDirect-XXX.json` siguiendo el mismo schema y
añadir un script y workflow análogos.
