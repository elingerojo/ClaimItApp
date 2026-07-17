# Pasos para Base de Datos Neon

Ejecutar en orden en tu base de datos Neon (usar SQL Editor en Neon Console o psql).

---

## Paso 1: Crear tabla `events`

```sql
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT,
    published_at TIMESTAMPTZ NOT NULL,
    available_from TIMESTAMPTZ NOT NULL,
    pickup_window_hours INTEGER NOT NULL DEFAULT 24,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'scheduled', 'active', 'completed')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Paso 2: Agregar columnas a `items`

```sql
ALTER TABLE items ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS visible_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS available_from TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_items_event_id ON items(event_id);
CREATE INDEX IF NOT EXISTS idx_items_visible_at ON items(visible_at);
CREATE INDEX IF NOT EXISTS idx_items_available_from ON items(available_from);
```

## Paso 3: Agregar columnas a `claims`

```sql
ALTER TABLE claims ADD COLUMN IF NOT EXISTS pickup_deadline TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS picked_up BOOLEAN DEFAULT FALSE;
```

## Paso 4: Verificar migración

```sql
-- Ver tablas y columnas
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('events', 'items', 'claims')
ORDER BY table_name, ordinal_position;

-- Items sin evento asignado (los existentes)
SELECT COUNT(*) as items_sin_evento FROM items WHERE event_id IS NULL;
```

---

## Notas

- Todos los `ALTER TABLE` usan `IF NOT EXISTS` — son seguros de ejecutar múltiples veces.
- Los items existentes quedan con `event_id = NULL`. Siguen funcionando como antes (sin evento asignado).
- Las columnas `visible_at` y `available_from` en items son **override individual**. Si están NULL, el item usa las fechas de su evento (si tiene).
- La columna `expires_at` es opcional para futura funcionalidad de expiración de items. Puede ignorarse por ahora.
