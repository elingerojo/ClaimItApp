/**
 * frontend/src/app/utils/item-condition.ts — Presentación al visitante del
 * estado físico del item (SP6).
 *
 * Responsabilidad única: traducir los 5 campos NULL-ables del estado físico
 * (decisiones 2 y 5 del plan `plans/estado-fisico-item.md`) a la lista de chips
 * que ve el visitante, cada uno con su etiqueta ES y sus clases Tailwind.
 *
 * Reglas que este helper garantiza:
 *  - NUNCA reescribe una etiqueta de opción: las etiquetas salen del catálogo y
 *    de los vocabularios compartidos (`shared/itemCondition.ts`, reexportados por
 *    `shared/index.ts`), de modo que el texto del visitante no puede derivar del
 *    texto del admin (riesgo documentado en el plan §9).
 *  - `null` / `undefined` / código desconocido ⇒ NO se emite chip (decisión 2).
 *    Sin campos ⇒ lista vacía, y la plantilla no pinta ningún contenedor.
 *  - Orden fijo del §7: Estado físico, Empaque, Accesorios, Uso, Funcionamiento.
 *  - SOLO informativo (decisión 5): este módulo no calcula ni altera precio,
 *    multiplicadores, visibilidad, fases, orden del catálogo ni reglas de claim.
 *
 * El mapeo tono semántico → clases Tailwind vive AQUÍ (y no en `shared/`) porque
 * `shared` es agnóstico de framework: su contrato solo publica tokens de tono
 * (`ConditionGradeTone`) y es el frontend quien decide cómo se pinta. Las clases
 * se escriben como literales completos para que el detector de fuentes de
 * Tailwind las encuentre dentro de `frontend/`.
 */

import {
  CONDITION_ACCESSORIES_FIELD_LABEL,
  CONDITION_ACCESSORIES_LABELS,
  CONDITION_FUNCTIONALITY_FIELD_LABEL,
  CONDITION_FUNCTIONALITY_LABELS,
  CONDITION_PACKAGING_FIELD_LABEL,
  CONDITION_PACKAGING_LABELS,
  CONDITION_USAGE_FIELD_LABEL,
  CONDITION_USAGE_LABELS,
  getConditionGradeEntry,
  isConditionAccessories,
  isConditionFunctionality,
  isConditionPackaging,
  isConditionUsage
} from '@claimitapp/shared';
import type {
  ConditionAccessories,
  ConditionFunctionality,
  ConditionGrade,
  ConditionGradeTone,
  ConditionPackaging,
  ConditionUsage
} from '@claimitapp/shared';

// ---------------------------------------------------------------------------
// Caption de la columna del grado
// ---------------------------------------------------------------------------

/**
 * Caption de la columna `condition_grade` = `Estado físico` (plan §2.3).
 *
 * Se define AQUÍ, en el frontend, porque `shared/itemCondition.ts` publica
 * etiquetas de columna para los 4 calificadores (`CONDITION_*_FIELD_LABEL`)
 * pero NO una para el grado, y SP6 tiene prohibido editar `shared/**`. Definirla
 * una sola vez en este util evita repetir el literal en las dos plantillas y
 * deja un único punto de cambio si algún día `shared` la exporta. Es la MISMA
 * cadena que usa hoy el admin (`conditionFieldLabels.grade` en `admin-ingest`),
 * así que ambas superficies siguen coincidiendo.
 */
export const CONDITION_GRADE_FIELD_LABEL = 'Estado físico';

// ---------------------------------------------------------------------------
// Tono semántico (shared) → clases Tailwind (frontend)
// ---------------------------------------------------------------------------

/**
 * Rampa de tonos, de mejor a peor: emerald → teal → gray → amber → orange →
 * red. Cubre exactamente `CONDITION_GRADE_TONES` de `shared` (6 tokens), con un
 * color distinto por token para no colapsar la lectura del catálogo.
 */
export const CONDITION_GRADE_TONE_CLASSES: Readonly<Record<ConditionGradeTone, string>> =
  Object.freeze({
    success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    good: 'bg-teal-50 text-teal-700 border-teal-200',
    neutral: 'bg-gray-50 text-gray-600 border-gray-200',
    caution: 'bg-amber-50 text-amber-700 border-amber-200',
    warning: 'bg-orange-50 text-orange-700 border-orange-200',
    danger: 'bg-red-50 text-red-700 border-red-200'
  });

/**
 * Clases neutras: los 4 calificadores (que en `shared` NO tienen tono porque no
 * son una jerarquía, son información) y cualquier tono inesperado en datos
 * escritos a mano. Es el mismo par que el tono `neutral` para no introducir un
 * séptimo color en la UI.
 */
export const CONDITION_CHIP_NEUTRAL_CLASSES = 'bg-gray-50 text-gray-600 border-gray-200';

/** Base del chip en el modal de detalle. */
const CHIP_DETAIL_BASE_CLASSES =
  'inline-flex items-center text-[10px] font-bold px-2.5 py-1 rounded-full border';

/**
 * Base del chip compacto de la tarjeta del listado. Reutiliza la escala de los
 * pines pequeños que ya existen en la tarjeta (p. ej. el marcador `IA`):
 * `text-[9px]` + `px-2 py-px` + `rounded-full`. El `mt-1` viaja DENTRO del chip
 * para que, cuando el item no tenga estado físico, no quede un margen huérfano.
 */
const CHIP_COMPACT_BASE_CLASSES =
  'mt-1 inline-flex items-center text-[9px] font-bold uppercase tracking-wider px-2 py-px rounded-full border';

/**
 * Clases del chip de grado según el tono del catálogo compartido. Recibe
 * `unknown` a propósito: si llegara un tono fuera del mapa (dato escrito a mano
 * que no pasó por el tipo), cae a las clases neutras en lugar de romper el render.
 */
export function conditionGradeToneClasses(tone: unknown): string {
  if (
    typeof tone === 'string' &&
    Object.prototype.hasOwnProperty.call(CONDITION_GRADE_TONE_CLASSES, tone)
  ) {
    return CONDITION_GRADE_TONE_CLASSES[tone as ConditionGradeTone];
  }
  return CONDITION_CHIP_NEUTRAL_CLASSES;
}

// ---------------------------------------------------------------------------
// Entrada y salida
// ---------------------------------------------------------------------------

/**
 * Entrada mínima del helper: los 5 campos del estado físico tal como los expone
 * el contrato ([`ItemWithQueue`](frontend/src/app/services/inventory.ts:112),
 * plan §2.4 paso 4). Se declara aquí, en lugar de importar `ItemWithQueue`, para
 * que el util no dependa de Angular ni del servicio de inventario y pueda
 * ejecutarse con `node` sin navegador (prueba DB-free de SP6). Es
 * estructuralmente compatible con `ItemWithQueue`, así que las plantillas pasan
 * `item()` sin conversión.
 */
export interface ConditionFieldsSource {
  readonly conditionGrade?: ConditionGrade | null;
  readonly conditionPackaging?: ConditionPackaging | null;
  readonly conditionAccessories?: ConditionAccessories | null;
  readonly conditionUsage?: ConditionUsage | null;
  readonly conditionFunctionality?: ConditionFunctionality | null;
}

/** Clave estable del chip (= nombre camelCase del campo en el contrato). */
export type ConditionChipKey = 'grade' | 'packaging' | 'accessories' | 'usage' | 'functionality';

/** Chip listo para pintar, sin dependencia de framework. */
export interface ConditionChip {
  /** Campo del que proviene (para `track` en `@for` y para depurar). */
  readonly key: ConditionChipKey;
  /** Etiqueta ES: SIEMPRE del catálogo/vocabulario compartido. */
  readonly label: string;
  /** Texto del atributo `title`: "<caption de columna>: <etiqueta>". */
  readonly title: string;
  /** Clases Tailwind completas (base + tono) del `<span>` del chip. */
  readonly classes: string;
}

/**
 * Orden de render fijado por el plan §7: el grado primero y después Empaque,
 * Accesorios, Uso y Funcionamiento. Esta lista ES el orden real de salida:
 * `conditionChips` itera sobre ella, así que no existe una segunda secuencia que
 * pueda desincronizarse.
 */
export const CONDITION_CHIP_ORDER: readonly ConditionChipKey[] = Object.freeze([
  'grade',
  'packaging',
  'accessories',
  'usage',
  'functionality'
]);

/** Clave de chip que NO es el grado (los 4 calificadores). */
type QualifierChipKey = Exclude<ConditionChipKey, 'grade'>;

/**
 * Especificación de un calificador: de dónde sale su valor, cómo se valida
 * contra el vocabulario cerrado compartido y de qué mapa compartido sale su
 * etiqueta. Tenerlo como dato (y no como 4 bloques de `if`) mantiene las
 * etiquetas y los guards pegados a su columna.
 */
interface QualifierSpec {
  /** Etiqueta de la columna (también del catálogo compartido). */
  readonly fieldLabel: string;
  /**
   * Etiqueta ES del valor, o `null` si el valor es null/undefined o no
   * pertenece al vocabulario (nunca lanza).
   */
  readonly resolve: (source: ConditionFieldsSource) => string | null;
}

/**
 * Un spec por calificador. `Record` EXHAUSTIVO: agregar una clave a
 * `ConditionChipKey` sin spec aquí es un error de compilación. El orden de
 * declaración es irrelevante a propósito: el orden de salida lo dicta
 * `CONDITION_CHIP_ORDER`.
 */
const QUALIFIER_SPEC_BY_KEY: Readonly<Record<QualifierChipKey, QualifierSpec>> = {
  packaging: {
    fieldLabel: CONDITION_PACKAGING_FIELD_LABEL,
    resolve: (source) =>
      isConditionPackaging(source.conditionPackaging)
        ? CONDITION_PACKAGING_LABELS[source.conditionPackaging]
        : null
  },
  accessories: {
    fieldLabel: CONDITION_ACCESSORIES_FIELD_LABEL,
    resolve: (source) =>
      isConditionAccessories(source.conditionAccessories)
        ? CONDITION_ACCESSORIES_LABELS[source.conditionAccessories]
        : null
  },
  usage: {
    fieldLabel: CONDITION_USAGE_FIELD_LABEL,
    resolve: (source) =>
      isConditionUsage(source.conditionUsage) ? CONDITION_USAGE_LABELS[source.conditionUsage] : null
  },
  functionality: {
    fieldLabel: CONDITION_FUNCTIONALITY_FIELD_LABEL,
    resolve: (source) =>
      isConditionFunctionality(source.conditionFunctionality)
        ? CONDITION_FUNCTIONALITY_LABELS[source.conditionFunctionality]
        : null
  }
};

// ---------------------------------------------------------------------------
// Constructores de chips
// ---------------------------------------------------------------------------

/** Escala soportada: chip del modal de detalle o chip compacto de la tarjeta. */
type ChipScale = 'detail' | 'compact';

/**
 * Construye el chip del grado. `getConditionGradeEntry` NUNCA lanza: devuelve
 * `undefined` para `null`/`undefined`, para códigos desconocidos y para claves
 * heredadas de `Object.prototype` (p. ej. 'constructor'), así que basta con
 * tratarlo como "sin chip".
 */
function buildGradeChip(
  source: ConditionFieldsSource | null | undefined,
  scale: ChipScale
): ConditionChip | null {
  const entry = getConditionGradeEntry(source?.conditionGrade);
  if (!entry) return null;
  const base = scale === 'compact' ? CHIP_COMPACT_BASE_CLASSES : CHIP_DETAIL_BASE_CLASSES;
  return {
    key: 'grade',
    label: entry.label,
    title: `${CONDITION_GRADE_FIELD_LABEL}: ${entry.label}`,
    classes: `${base} ${conditionGradeToneClasses(entry.tone)}`
  };
}

/** Chip del grado para el modal de detalle (o `null` si no hay valor válido). */
export function conditionGradeChip(
  source: ConditionFieldsSource | null | undefined
): ConditionChip | null {
  return buildGradeChip(source, 'detail');
}

/**
 * Chip COMPACTO del grado para la tarjeta del listado (o `null`). La tarjeta
 * solo muestra el grado: los calificadores viven en el detalle.
 */
export function conditionGradeCompactChip(
  source: ConditionFieldsSource | null | undefined
): ConditionChip | null {
  return buildGradeChip(source, 'compact');
}

/**
 * Chips del estado físico para el modal de detalle, en el orden del §7.
 *
 * Devuelve lista VACÍA cuando los 5 campos son `null`/`undefined` (caso 1 de la
 * matriz del §6). La plantilla usa esa longitud como guard, de modo que en ese
 * caso no aparece contenedor, ni margen, ni bloque vacío en el DOM.
 */
export function conditionChips(source: ConditionFieldsSource | null | undefined): ConditionChip[] {
  const chips: ConditionChip[] = [];
  for (const key of CONDITION_CHIP_ORDER) {
    if (key === 'grade') {
      const grade = buildGradeChip(source, 'detail');
      if (grade) chips.push(grade);
      continue;
    }
    if (!source) continue;
    const spec = QUALIFIER_SPEC_BY_KEY[key];
    const label = spec.resolve(source);
    if (label === null) continue; // null/undefined/código desconocido ⇒ sin chip
    chips.push({
      key,
      label,
      title: `${spec.fieldLabel}: ${label}`,
      classes: `${CHIP_DETAIL_BASE_CLASSES} ${CONDITION_CHIP_NEUTRAL_CLASSES}`
    });
  }
  return chips;
}
