import * as _ from 'lodash';
import * as Promise from 'bluebird';
import { settleMapSeries } from './control-flow';

export type RollbackAction = () => void | Promise<void>;
export type HookFn<T extends any[]> = (...args: T) => any;
export type HookBlueprint<T extends any[]> = {
	HOOK: HookFn<T>;
	effects: boolean;
};
export type InstantiatedHooks<
	T extends { [key in keyof T]: (...args: Parameters<T[key]>) => any }
> = { [key in keyof T]: Array<Hook<Parameters<T[key]>>> };

export class Hook<T extends any[]> {
	constructor(private hookFn: HookFn<T>) {}

	run(...args: T) {
		return Promise.try(() => {
			return this.hookFn(...args);
		});
	}
}

export class SideEffectHook<T extends any[]> extends Hook<T> {
	private rollbackFns: RollbackAction[] = [];
	private rolledBack: boolean = false;

	constructor(hookFn: HookFn<T>) {
		super(hookFn);
	}

	registerRollback(fn: RollbackAction) {
		if (this.rolledBack) {
			Promise.try(fn);
		} else {
			this.rollbackFns.push(fn);
		}
	}

	rollback() {
		// Don't try to call the rollback functions twice
		if (this.rolledBack) {
			return;
		}
		// set rolledBack to true straight away, so that if any rollback action
		// is registered after the rollback call, we will immediately execute it
		this.rolledBack = true;
		return settleMapSeries(this.rollbackFns, fn => fn()).return();
	}
}

// The execution order of rollback actions is unspecified
export const rollbackRequestHooks = Promise.method(
	<T extends InstantiatedHooks<any>>(hooks: T | undefined): void => {
		if (hooks == null) {
			return;
		}
		settleMapSeries(
			_(hooks)
				.flatMap()
				.compact()
				.value(),
			hook => {
				if (hook instanceof SideEffectHook) {
					return hook.rollback();
				}
			},
		);
	},
);

export const instantiateHooks = <
	T extends { [key in keyof T]: (...args: Parameters<T[key]>) => any }
>(
	hooks: { [key in keyof T]: HookBlueprint<Parameters<T[key]>>[] },
) =>
	_.mapValues(hooks, typeHooks => {
		return _.map(typeHooks, (hook: HookBlueprint<any[]>) => {
			if (hook.effects) {
				return new SideEffectHook(hook.HOOK);
			} else {
				return new Hook(hook.HOOK);
			}
		});
	}) as InstantiatedHooks<T>;
