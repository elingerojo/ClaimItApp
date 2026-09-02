import { Request, Response } from 'express';
import pool from '../config/db.js';
import { upsertUser, renameUserInStore } from '../cache/appStore.js';
import { broadcastSseEvent } from '../config/sse.js';

/**
 * POST /api/session
 *
 * Resuelve una sesión de usuario.
 *
 * El UUID se origina en el navegador (crypto.randomUUID()).
 * El servidor es reactivo: valida alias único y responde.
 *
 * El flag `isFromSession` (opcional, enviado por el navegador) indica si el
 * UUID se cargó de localStorage (true) o se acaba de generar (false/omitido).
 * Esto permite al servidor distinguir entre:
 *   - Usuario legacy de una V1 cuya BD fue reemplazada (isFromSession=true, UUID no existe)
 *   - Usuario completamente nuevo (isFromSession=false)
 * Útil para migraciones futuras no-compatibles.
 *
 * ---
 *
 * Caso A: Alias NO existe en BD
 *   - Si UUID tampoco existe → INSERT nuevo usuario
 *   - Si UUID ya existe (cambio de alias) → UPDATE alias
 *   → Response 201/200 { uuid, alias, email, phone, isNew }
 *
 * Caso B: Alias SÍ existe en BD
 *   - Si UUID coincide → OK, misma sesión
 *   - Si UUID NO coincide → CONFLICTO
 *   → Response 409 { conflict: true, storedUuid, storedAlias }
 */
export const resolveSession = async (req: Request, res: Response): Promise<void> => {
  const { uuid, alias, email, phone, isFromSession } = req.body;

  if (!uuid || !alias?.trim()) {
    res.status(400).json({ error: 'uuid and alias are required.' });
    return;
  }

  const cleanAlias = alias.trim();

  try {
    // 1. Buscar si el alias ya existe (case-insensitive)
    const aliasResult = await pool.query(
      'SELECT uuid, alias, email, phone, global_role FROM users WHERE LOWER(alias) = LOWER($1)',
      [cleanAlias]
    );

    if (aliasResult.rows.length > 0) {
      const existingUser = aliasResult.rows[0];

      // 2. Alias existe — ¿coincide el UUID?
      if (existingUser.uuid === uuid) {
        // Mismo usuario, mismo alias → todo bien.
        // Caso A1: si el cliente reenvía correo/teléfono (p. ej. editar solo el
        // contacto desde "Cambiar Alias" sin cambiar el alias), persistirlos.
        await pool.query(
          'UPDATE users SET email = COALESCE($2, email), phone = COALESCE($3, phone) WHERE uuid = $1',
          [existingUser.uuid, email || null, phone || null]
        );
        const persistedEmail = email || existingUser.email;
        const persistedPhone = phone || existingUser.phone;

        upsertUser({ uuid: existingUser.uuid, alias: existingUser.alias, global_role: existingUser.global_role });
        res.json({
          uuid: existingUser.uuid,
          alias: existingUser.alias,
          email: persistedEmail,
          phone: persistedPhone,
          globalRole: existingUser.global_role,
          isNew: false
        });
        return;
      } else {
        // Conflicto: alias tomado por otro UUID
        res.status(409).json({
          conflict: true,
          storedUuid: existingUser.uuid,
          storedAlias: existingUser.alias,
          message: `El alias "${cleanAlias}" ya está siendo usado.`
        });
        return;
      }
    }

    // 3. Alias no existe — ¿existe el UUID? (cambio de alias)
    const uuidResult = await pool.query(
      'SELECT uuid, alias, email, phone, global_role FROM users WHERE uuid = $1',
      [uuid]
    );

    if (uuidResult.rows.length > 0) {
      const isAliasChange = uuidResult.rows[0].alias !== cleanAlias;

      // El UUID ya existe (cambio de alias / edición de contacto) → UPDATE.
      // Mantener el MISMO UUID es lo que conserva los apartados (userUuid).
      await pool.query(
        'UPDATE users SET alias = $1, email = COALESCE($2, email), phone = COALESCE($3, phone) WHERE uuid = $4',
        [cleanAlias, email || null, phone || null, uuid]
      );

      upsertUser({ uuid, alias: cleanAlias, global_role: uuidResult.rows[0].global_role });

      // Si el alias cambió, propagarlo a las colas existentes (claims.username
      // en Neon + store RAM) y notificar por SSE para que todos los clientes
      // muestren el nuevo vanity name.
      if (isAliasChange) {
        await pool.query('UPDATE claims SET username = $1 WHERE user_uuid = $2', [cleanAlias, uuid]);
        renameUserInStore(uuid, cleanAlias);
        broadcastSseEvent('user_renamed', { userUuid: uuid, alias: cleanAlias });
      }

      res.json({
        uuid,
        alias: cleanAlias,
        email: email || uuidResult.rows[0].email,
        phone: phone || uuidResult.rows[0].phone,
        globalRole: uuidResult.rows[0].global_role,
        isNew: false
      });
      return;
    }

    // 4. Nuevo usuario: UUID + alias no existen
    // Aquí isFromSession=true + UUID no existe = posible usuario legacy de V1 cuyo alias
    // está libre en la nueva BD. Se crea igual, pero el servidor podría:
    //   - Registrar en logs que es un usuario migrando
    //   - Devolver un mensaje especial: "databaseReset: true"
    //   - En el futuro, aplicar lógica de migración de datos
    const isLegacyUser = isFromSession === true;

    await pool.query(
      'INSERT INTO users (uuid, alias, email, phone) VALUES ($1, $2, $3, $4)',
      [uuid, cleanAlias, email || null, phone || null]
    );

    if (isLegacyUser) {
      console.log(`[Session] Legacy user re-created after DB reset: uuid=${uuid}, alias=${cleanAlias}`);
    }

    upsertUser({ uuid, alias: cleanAlias, global_role: 'publico' });

    res.status(201).json({
      uuid,
      alias: cleanAlias,
      email: email || null,
      phone: phone || null,
      globalRole: 'publico',
      isNew: true,
      ...(isLegacyUser && { databaseReset: true })
    });

  } catch (error) {
    console.error('Session resolution failed:', error);
    res.status(500).json({ error: 'Internal error resolving user session.' });
  }
};

interface SessionResponse {
  uuid: string;
  alias: string;
  email: string | null;
  phone: string | null;
  isNew?: boolean;
  conflict?: boolean;
  storedUuid?: string;
  storedAlias?: string;
  message?: string;
  databaseReset?: boolean;
}
