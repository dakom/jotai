import { atom } from '../../vanilla.ts'
import type { Atom, Getter, WritableAtom } from '../../vanilla.ts'

type Timeout = ReturnType<typeof setTimeout>
type AnyError = unknown

declare global {
  interface SymbolConstructor {
    readonly observable: symbol
  }
}

type Subscription = {
  unsubscribe: () => void
}

type Observer<T> = {
  next: (value: T) => void
  error: (error: AnyError) => void
  complete: () => void
}

type ObservableLike<T> = {
  [Symbol.observable]?: () => ObservableLike<T> | undefined
} & (
  | {
      subscribe(observer: Observer<T>): Subscription
    }
  | {
      subscribe(observer: Partial<Observer<T>>): Subscription
    }
  | {
      subscribe(observer: Partial<Observer<T>>): Subscription
      // Overload function to make typing happy
      subscribe(next: (value: T) => void): Subscription
    }
)

type SubjectLike<T> = ObservableLike<T> &
  Observer<T> & {
    // only available in BehaviorSubject
    getValue?: () => T
  }

type Options<Data> = {
  initialValue?: Data | (() => Data)
  unstable_timeout?: number
}

type OptionsWithInitialValue<Data> = {
  initialValue: Data | (() => Data)
  unstable_timeout?: number
}

export function atomWithObservable<Data>(
  getObservable: (get: Getter) => SubjectLike<Data>,
  options: OptionsWithInitialValue<Data>
): WritableAtom<Data, [Data], void>

export function atomWithObservable<Data>(
  getObservable: (get: Getter) => SubjectLike<Data>,
  options?: Options<Data>
): WritableAtom<Data | Promise<Data>, [Data], void>

export function atomWithObservable<Data>(
  getObservable: (get: Getter) => ObservableLike<Data>,
  options: OptionsWithInitialValue<Data>
): Atom<Data>

export function atomWithObservable<Data>(
  getObservable: (get: Getter) => ObservableLike<Data>,
  options?: Options<Data>
): Atom<Data | Promise<Data>>

export function atomWithObservable<Data>(
  getObservable: (get: Getter) => ObservableLike<Data> | SubjectLike<Data>,
  options?: Options<Data>
) {
  type Result = { d: Data } | { e: AnyError }

  let timer: Timeout | undefined
  let subscription: Subscription | undefined

  const clearSubscription = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (subscription) {
      subscription.unsubscribe()
      subscription = undefined
    }
  }

  /*
    Atom composition:
    1. observableAtom: For the initial unresolved promise
       - also sets the next atom on subsequent values
    2. directAtom: For the latest result after that initial promise
        or writing to the atom directly from the outside world
    3. resultAtom: composes these into the true final result
    4. finalAtom: returns the result and manages subscription lifecycle
  */

  let setDirectResult: ((result: Result) => void) | undefined
  const directAtom = atom<Result | undefined>(undefined)
  directAtom.onMount = (update) => {
    setDirectResult = update
  }

  const observableAtom = atom<Promise<Result>>((get) => {
    let observable = getObservable(get)

    const itself = observable[Symbol.observable]?.()
    if (itself) {
      observable = itself
    }

    let resolveResult: ((result: Result) => void) | undefined
    const promise = new Promise<Result>((resolve) => {
      resolveResult = (data) => {
        resolve(data)
        // makes it easier to reason about that we either
        // resolve the promise or set the data, never both
        resolveResult = undefined
      }
    })

    const listener = (result: Result) => {
      if (resolveResult) {
        resolveResult(result)
      } else if (setDirectResult) {
        setDirectResult(result)
      }
    }

    console.log('start called', Date.now())

    clearSubscription()
    subscription = observable.subscribe({
      next: (d) => listener({ d }),
      error: (e) => listener({ e }),
      complete: () => {},
    })

    if (options && 'initialValue' in options) {
      listener({
        d:
          typeof options.initialValue === 'function'
            ? (options.initialValue as () => Data)()
            : (options.initialValue as Data),
      })
    }

    if (options?.unstable_timeout) {
      timer = setTimeout(() => {
        clearSubscription()
      }, options.unstable_timeout)
    }

    return promise
  })

  const finalAtom = atom(
    async (get) => {
      const directResult = get(directAtom)
      const promiseResult = await get(observableAtom)
      const result = directResult ?? promiseResult

      console.log(result)
      if ('e' in result) {
        throw result.e
      }
      return result.d
    },
    (_get, _set, value: Data) => {
      if (setDirectResult) {
        setDirectResult({ d: value })
      }
    }
  )

  finalAtom.onMount = () => {
    return () => {
      console.log('final atom unmounted')
      clearSubscription()
    }
  }

  if (import.meta.env?.MODE !== 'production') {
    finalAtom.debugPrivate = true
  }

  return finalAtom
}
