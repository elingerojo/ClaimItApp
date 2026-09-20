/**
 * shared/itemCondition.ts — Dominio del estado físico del item (SP3).
 *
 * Fuente única del catálogo de `condition_grade` y de los 4 vocabularios de
 * calificadores definidos en `plans/estado-fisico-item.md` §2.1 y §2.2.
 *
 * Reglas del dominio (decisiones bloqueadas del plan §1):
 *  - 100% manual: lo captura el ADMIN; NUNCA se deriva ni se sugiere por IA.
 *  - Todos los campos son NULL-ables: `null` = "no proporcionado" ⇒ la UI del
 *    visitante no debe renderizar el campo.
 *  - SOLO informativo: no altera precio, multiplicadores, orden del catálogo ni
 *    reglas de claim.
 *
 * Este módulo es agnóstico de framework: no importa React/Angular/Tailwind y no
 * contiene clases CSS. El `tone` es un token semántico (no un color) y la UI
 * decide cómo se pinta. La única dependencia es `./types.js` (los union types),
 * de modo que la dirección de importación es itemCondition.ts → types.ts y nunca
 * al revés (evita ciclos).
 */

import type {
  ConditionAccessories,
  ConditionFunctionality,
  ConditionGrade,
  ConditionPackaging,
  ConditionUsage
} from './types.js';

// ---------------------------------------------------------------------------
// Estado físico — catálogo ORDENADO (mejor → peor, rank 7→1)
// ---------------------------------------------------------------------------

/**
 * Token semántico de tono para el chip del estado físico. NO es una clase CSS:
 * el frontend (SP6) mapea token → estilos. Se mantiene deliberadamente abstracto
 * para que la capa shared siga siendo agnóstica de framework y para que la
 * detección de fuentes de Tailwind no dependa de archivos fuera de `frontend/`.
 */
export type ConditionGradeTone =
  | 'success'
  | 'good'
  | 'neutral'
  | 'caution'
  | 'warning'
  | 'danger';

/** Todos los tonos existentes (útil para mapeos exhaustivos en la UI). */
export const CONDITION_GRADE_TONES: readonly ConditionGradeTone[] = [
  'success',
  'good',
  'neutral',
  'caution',
  'warning',
  'danger'
];

/** Entrada del catálogo ordenado de `condition_grade`. */
export interface ConditionGradeEntry {
  /** Código persistido en `items.condition_grade` (VARCHAR(20) + CHECK). */
  readonly code: ConditionGrade;
  /** Etiqueta de UI en español. */
  readonly label: string;
  /** Orden de valor: 7 = mejor, 1 = peor. */
  readonly rank: number;
  /** Token semántico de tono del chip (no es una clase CSS). */
  readonly tone: ConditionGradeTone;
  /** Composición típica documentada (plan §2.1). */
  readonly composition: string;
}

/**
 * Catálogo de `condition_grade` como `Record` EXHAUSTIVO: agregar un código al
 * union `ConditionGrade` sin agregarlo aquí es un error de compilación, y una
 * clave duplicada es un error del literal de objeto. Es la ÚNICA estructura
 * escrita a mano; el orden de render se deriva de `rank` (ver
 * `CONDITION_GRADES_ORDERED`), de modo que el orden no puede desincronizarse.
 */
export const CONDITION_GRADE_CATALOG: Readonly<
  Record<ConditionGrade, ConditionGradeEntry>
> = {
  nuevo_sellado: {
    code: 'nuevo_sellado',
    label: 'Nuevo (sellado)',
    rank: 7,
    tone: 'success',
    composition:
      'Uso `nuevo` + empaque `original_sellado` + accesorios `todos` + funcionamiento `perfecto`'
  },
  como_nuevo: {
    code: 'como_nuevo',
    label: 'Como nuevo',
    rank: 6,
    tone: 'success',
    composition:
      'Uso `usado` + empaque `original_abierto` + accesorios `todos` + funcionamiento `como_nuevo`'
  },
  excelente: {
    code: 'excelente',
    label: 'Excelente',
    rank: 5,
    tone: 'good',
    composition:
      'Uso `usado` + empaque `envuelto_sin_caja` + accesorios `todos` + funcionamiento `normal`'
  },
  bueno: {
    code: 'bueno',
    label: 'Bueno',
    rank: 4,
    tone: 'neutral',
    composition:
      'Uso `usado` + empaque `sin_empaque` + accesorios `algunos` + funcionamiento `normal`'
  },
  regular: {
    code: 'regular',
    label: 'Regular',
    rank: 3,
    tone: 'caution',
    composition: 'Desgaste visible; funciona `normal`'
  },
  con_fallas: {
    code: 'con_fallas',
    label: 'Con fallas',
    rank: 2,
    tone: 'warning',
    composition: 'Funcionamiento parcial o faltantes importantes'
  },
  para_refacciones: {
    code: 'para_refacciones',
    label: 'No funciona (para refacciones)',
    rank: 1,
    tone: 'danger',
    composition: 'Funcionamiento `no_funciona`'
  }
};

/**
 * Catálogo ORDENADO de mejor a peor (rank 7→1). Es el orden en que la UI debe
 * renderizar el `select` del admin. Se DERIVA del catálogo ordenando por `rank`,
 * así que no existe una segunda lista que pueda quedar desactualizada.
 */
export const CONDITION_GRADES_ORDERED: readonly ConditionGradeEntry[] = Object.freeze(
  Object.values(CONDITION_GRADE_CATALOG).sort((a, b) => b.rank - a.rank)
);

/** Códigos en orden de valor, mejor → peor (rank 7→1). */
export const CONDITION_GRADE_ORDER: readonly ConditionGrade[] = Object.freeze(
  CONDITION_GRADES_ORDERED.map((entry) => entry.code)
);

/**
 * Vista del catálogo con índice por string arbitrario, para hacer el lookup
 * seguro sin `as` en el sitio de uso.
 */
const CONDITION_GRADE_BY_CODE: Readonly<
  Record<string, ConditionGradeEntry | undefined>
> = CONDITION_GRADE_CATALOG;

/**
 * Lookup por código. NUNCA lanza: devuelve `undefined` para cualquier entrada
 * desconocida, para tipos no-string y también para claves heredadas de
 * `Object.prototype` (p. ej. 'constructor' o 'toString', que un lookup ingenuo
 * resolvería como acierto).
 */
export function getConditionGradeEntry(code: unknown): ConditionGradeEntry | undefined {
  if (typeof code !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(CONDITION_GRADE_CATALOG, code)) return undefined;
  return CONDITION_GRADE_BY_CODE[code];
}

/** Type guard del vocabulario de `condition_grade`. */
export function isConditionGrade(value: unknown): value is ConditionGrade {
  return getConditionGradeEntry(value) !== undefined;
}

/** Etiqueta ES del código o `null` si el código no pertenece al catálogo. */
export function conditionGradeLabel(code: unknown): string | null {
  return getConditionGradeEntry(code)?.label ?? null;
}

/** Token de tono estable del código o `null` si no pertenece al catálogo. */
export function conditionGradeTone(code: unknown): ConditionGradeTone | null {
  return getConditionGradeEntry(code)?.tone ?? null;
}

// ---------------------------------------------------------------------------
// Calificadores — 4 vocabularios cerrados (plan §2.2)
// ---------------------------------------------------------------------------

/** Opción de un vocabulario de calificador: valor persistido + etiqueta ES. */
export interface ConditionQualifierOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * Guard de compilación: `AssertNever<X>` solo es válido cuando `X` es `never`.
 * Si se agrega un código nuevo a un union sin listarlo en el array de valores,
 * el `Exclude` deja de resolverse a `never` y la declaración falla al compilar.
 */
type AssertNever<T extends never> = T;

/**
 * Puente camelCase ↔ columna de BD de los 5 campos del estado físico. El contrato
 * de API/`Item` usa camelCase (`conditionGrade`, `conditionPackaging`, ...) y la
 * BD usa snake_case (`condition_grade`, `condition_packaging`, ...); este mapa
 * documenta el round-trip y evita teclear el nombre de la columna a mano en cada
 * capa de la cadena de propagación (plan §2.4, SP4).
 */
export const CONDITION_COLUMN_BY_FIELD = {
  conditionGrade: 'condition_grade',
  conditionPackaging: 'condition_packaging',
  conditionAccessories: 'condition_accessories',
  conditionUsage: 'condition_usage',
  conditionFunctionality: 'condition_functionality'
} as const;

/** Nombre camelCase (contrato `Item`/API) de un campo del estado físico. */
export type ConditionFieldName = keyof typeof CONDITION_COLUMN_BY_FIELD;

// ---- Empaque (`condition_packaging`) --------------------------------------

/** Etiqueta de UI de la columna. */
export const CONDITION_PACKAGING_FIELD_LABEL = 'Empaque';

/** Valores en el orden del plan §2.2 (orden de render sugerido). */
export const CONDITION_PACKAGING_VALUES = [
  'original_sellado',
  'original_abierto',
  'envuelto_sin_caja',
  'sin_empaque'
] as const;

type _ConditionPackagingValuesComplete = AssertNever<
  Exclude<ConditionPackaging, (typeof CONDITION_PACKAGING_VALUES)[number]>
>;

/** Etiquetas ES por valor (Record exhaustivo). */
export const CONDITION_PACKAGING_LABELS: Readonly<Record<ConditionPackaging, string>> = {
  original_sellado: 'Original (sellado)',
  original_abierto: 'Original (abierto)',
  envuelto_sin_caja: 'Envuelto sin caja',
  sin_empaque: 'Sin empaque'
};

/** Opciones listas para render (valor + etiqueta), en orden del plan. */
export const CONDITION_PACKAGING_OPTIONS: readonly ConditionQualifierOption<ConditionPackaging>[] =
  Object.freeze(
    CONDITION_PACKAGING_VALUES.map((value) => ({
      value,
      label: CONDITION_PACKAGING_LABELS[value]
    }))
  );

/** Type guard del vocabulario de empaque. */
export function isConditionPackaging(value: unknown): value is ConditionPackaging {
  return (
    typeof value === 'string' &&
    (CONDITION_PACKAGING_VALUES as readonly string[]).includes(value)
  );
}

// ---- Accesorios (`condition_accessories`) ---------------------------------

/** Etiqueta de UI de la columna. */
export const CONDITION_ACCESSORIES_FIELD_LABEL = 'Accesorios';

/** Valores en el orden del plan §2.2. */
export const CONDITION_ACCESSORIES_VALUES = ['todos', 'algunos', 'sin'] as const;

type _ConditionAccessoriesValuesComplete = AssertNever<
  Exclude<ConditionAccessories, (typeof CONDITION_ACCESSORIES_VALUES)[number]>
>;

/** Etiquetas ES por valor (Record exhaustivo). */
export const CONDITION_ACCESSORIES_LABELS: Readonly<Record<ConditionAccessories, string>> = {
  todos: 'Todos',
  algunos: 'Algunos',
  sin: 'Sin accesorios'
};

/** Opciones listas para render (valor + etiqueta), en orden del plan. */
export const CONDITION_ACCESSORIES_OPTIONS: readonly ConditionQualifierOption<ConditionAccessories>[] =
  Object.freeze(
    CONDITION_ACCESSORIES_VALUES.map((value) => ({
      value,
      label: CONDITION_ACCESSORIES_LABELS[value]
    }))
  );

/** Type guard del vocabulario de accesorios. */
export function isConditionAccessories(value: unknown): value is ConditionAccessories {
  return (
    typeof value === 'string' &&
    (CONDITION_ACCESSORIES_VALUES as readonly string[]).includes(value)
  );
}

// ---- Uso (`condition_usage`) ----------------------------------------------

/** Etiqueta de UI de la columna. */
export const CONDITION_USAGE_FIELD_LABEL = 'Uso';

/** Valores en el orden del plan §2.2. */
export const CONDITION_USAGE_VALUES = ['nuevo', 'usado'] as const;

type _ConditionUsageValuesComplete = AssertNever<
  Exclude<ConditionUsage, (typeof CONDITION_USAGE_VALUES)[number]>
>;

/** Etiquetas ES por valor (Record exhaustivo). */
export const CONDITION_USAGE_LABELS: Readonly<Record<ConditionUsage, string>> = {
  nuevo: 'Nuevo',
  usado: 'Usado'
};

/** Opciones listas para render (valor + etiqueta), en orden del plan. */
export const CONDITION_USAGE_OPTIONS: readonly ConditionQualifierOption<ConditionUsage>[] =
  Object.freeze(
    CONDITION_USAGE_VALUES.map((value) => ({
      value,
      label: CONDITION_USAGE_LABELS[value]
    }))
  );

/** Type guard del vocabulario de uso. */
export function isConditionUsage(value: unknown): value is ConditionUsage {
  return (
    typeof value === 'string' && (CONDITION_USAGE_VALUES as readonly string[]).includes(value)
  );
}

// ---- Funcionamiento (`condition_functionality`) ---------------------------

/** Etiqueta de UI de la columna. */
export const CONDITION_FUNCTIONALITY_FIELD_LABEL = 'Funcionamiento';

/** Valores en el orden del plan §2.2. */
export const CONDITION_FUNCTIONALITY_VALUES = [
  'perfecto',
  'como_nuevo',
  'normal',
  'se_desconoce',
  'no_funciona'
] as const;

type _ConditionFunctionalityValuesComplete = AssertNever<
  Exclude<ConditionFunctionality, (typeof CONDITION_FUNCTIONALITY_VALUES)[number]>
>;

/**
 * Etiquetas ES por valor (Record exhaustivo). La etiqueta de `perfecto` es
 * exactamente "100% (perfecto)" (plan §2.2): el identificador interno es
 * `perfecto`, NO el literal '100'.
 */
export const CONDITION_FUNCTIONALITY_LABELS: Readonly<
  Record<ConditionFunctionality, string>
> = {
  perfecto: '100% (perfecto)',
  como_nuevo: 'Como nuevo',
  normal: 'Normal',
  se_desconoce: 'Se desconoce',
  no_funciona: 'No funciona'
};

/** Opciones listas para render (valor + etiqueta), en orden del plan. */
export const CONDITION_FUNCTIONALITY_OPTIONS: readonly ConditionQualifierOption<ConditionFunctionality>[] =
  Object.freeze(
    CONDITION_FUNCTIONALITY_VALUES.map((value) => ({
      value,
      label: CONDITION_FUNCTIONALITY_LABELS[value]
    }))
  );

/** Type guard del vocabulario de funcionamiento. */
export function isConditionFunctionality(value: unknown): value is ConditionFunctionality {
  return (
    typeof value === 'string' &&
    (CONDITION_FUNCTIONALITY_VALUES as readonly string[]).includes(value)
  );
}
