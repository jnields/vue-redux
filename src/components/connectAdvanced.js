import invariant from 'invariant'
import Subscription from '../utils/Subscription'
import extractProps from '../utils/extractProps';

let hotReloadingVersion = 0
const refKey = 'instance'

function noop() {}
function makeSelectorStateful(sourceSelector, store) {
  // wrap the selector in an object that tracks its results between runs.
  const selector = {
    run: function runComponentSelector(props) {
      try {
        const nextProps = sourceSelector(store.getState(), props)
        if (nextProps !== selector.props || selector.error) {
          selector.shouldComponentUpdate = true
          selector.props = nextProps
          selector.error = null
        }
      } catch (error) {
        selector.shouldComponentUpdate = true
        selector.error = error
      }
    }
  }

  return selector
}

export default function connectAdvanced(
  /*
    selectorFactory is a func that is responsible for returning the selector function used to
    compute new props from state, props, and dispatch. For example:

      export default connectAdvanced((dispatch, options) => (state, props) => ({
        thing: state.things[props.thingId],
        saveThing: fields => dispatch(actionCreators.saveThing(props.thingId, fields)),
      }))(YourComponent)

    Access to dispatch is provided to the factory so selectorFactories can bind actionCreators
    outside of their selector as an optimization. Options passed to connectAdvanced are passed to
    the selectorFactory, along with displayName and WrappedComponent, as the second argument.

    Note that selectorFactory is responsible for all caching/memoization of inbound and outbound
    props. Do not use connectAdvanced directly without memoizing results between calls to your
    selector, otherwise the Connect component will re-render on every state or props change.
  */
  selectorFactory,
  // options object:
  {
    // the func used to compute this HOC's displayName from the wrapped component's displayName.
    // probably overridden by wrapper functions such as connect()
    getDisplayName = name => `connect-advanced-${name}`,

    // shown in error messages
    // probably overridden by wrapper functions such as connect()
    methodName = 'connectAdvanced',

    // if defined, the name of the property passed to the wrapped element indicating the number of
    // calls to render. useful for watching in react devtools for unnecessary re-renders.
    renderCountProp = undefined,

    // determines whether this HOC subscribes to store changes
    shouldHandleStateChanges = true,

    // the key of props/context to get the store
    storeKey = 'store',

    // if true, the wrapped element is exposed by this HOC via the getWrappedInstance() function.
    withRef = false,

    // additional options are passed through to the selectorFactory
    ...connectOptions
  } = {}
) {
  const subscriptionKey = storeKey + 'Subscription'
  const version = hotReloadingVersion++

  return function wrapWithConnect(WrappedComponent) {
    invariant(
      WrappedComponent && typeof WrappedComponent.render == 'function',
      `You must pass a component to the function returned by ` +
      `connect. Instead received ${JSON.stringify(WrappedComponent)}`
    )

    const wrappedComponentName = WrappedComponent.displayName
      || WrappedComponent.name
      || 'Component'

    const displayName = getDisplayName(wrappedComponentName)

    const selectorFactoryOptions = {
      ...connectOptions,
      getDisplayName,
      methodName,
      renderCountProp,
      shouldHandleStateChanges,
      storeKey,
      withRef,
      displayName,
      wrappedComponentName,
      WrappedComponent
    }

    const componentProps = extractProps(WrappedComponent, [storeKey, subscriptionKey]);
    const Connect = {
      getWrappedInstance() {
        invariant(withRef,
          `To access the wrapped instance, you need to specify ` +
          `{ withRef: true } in the options argument of the ${methodName}() call.`
        )
        return this.$refs[refKey]
      },
      inject: [storeKey, subscriptionKey],
      props: {
        ...componentProps,
        [storeKey]: {
          type: Object,
          default() {
            this.propsMode = false
            return this[storeKey]
          },
        },
        [subscriptionKey]: {
          type: Object,
          default() {
            this.subscriptionInjected = true;
            return this[subscriptionKey]
          },
        },
      },
      data() {
        // parentSubscription's source should match where store came from: props vs. injection.
        // A component connected to the store via props shouldn't use subscription from injection,
        // or vice versa.
        const parentSubscription = propsMode && subscriptionInjected
          ? null
          : this.$props[subscriptionKey];
        const store = this.$props[storeKey];

        const propsMode = Boolean(this.propsMode)
        const subscriptionInjected = Boolean(this.subscriptionInjected)

        // We don't actually want Vue to bind anything to our data props, so we use data as a
        // lifecycle method to provide a non-reactive binding that we can use to keep track of
        // various information - needs to happen after getting props but before providing
        // so this is our only option
        this.data = {
          version,
          renderCount: 0,
          store,
          propsMode,
          subscriptionInjected,
          parentSubscription,
          ...this.getSubscriptionData(store, parentSubscription),
          selector: this.getSelector(store)
        };
        return {};
      },
      provide() {
        // If this component received store from props, its subscription should be transparent
        // to any descendants receiving store+subscription via injection; it passes along
        // subscription passed to it. Otherwise, it shadows the parent subscription, which allows
        // Connect to control ordering of notifications to flow top-down.
        const subscription = this.data.propsMode
          ? this.data.parentSubscription
          : this.data.subscription;

        return { [subscriptionKey]: subscription }
      },
      methods: {
        getSelector(store) {
          const sourceSelector = selectorFactory(store.dispatch, selectorFactoryOptions)
          const selector = makeSelectorStateful(sourceSelector, store)
          selector.run(this.$props)
          return selector
        },
        getSubscriptionData(store, parentSubscription) {
          if (!shouldHandleStateChanges) return

          const subscription = new Subscription(
            store,
            parentSubscription,
            this.onStateChange.bind(this)
          )

          // `notifyNestedSubs` is duplicated to handle the case where the component is  unmounted in
          // the middle of the notification loop, where `this.subscription` will then be null. An
          // extra null check every change can be avoided by copying the method onto `this` and then
          // replacing it with a no-op on unmount. This can probably be avoided if Subscription's
          // listeners logic is changed to not call listeners that have been unsubscribed in the
          // middle of the notification loop.
          const notifyNestedSubs = subscription.notifyNestedSubs.bind(subscription)
          return { subscription, notifyNestedSubs }
        },
        onStateChange() {
          this.data.selector.run(this.$props)

          if (!this.data.selector.shouldComponentUpdate) {
            this.data.notifyNestedSubs()
          } else {
            this.$off('updatd', this.data.updated)
            this.data.updated = this.notifyNestedSubsOnComponentDidUpdate.bind(this)
            this.$on('updated', this.data.updated);
            this.$forceUpdate()
          }
        },
        notifyNestedSubsOnComponentDidUpdate() {
          // `updated` is conditionally implemented when `onStateChange` determines it
          // needs to notify nested subs. Once called, it unimplements itself until further state
          // changes occur. Doing it this way vs having a permanent `componentDidUpdate` that does
          // a boolean check every time avoids an extra method call most of the time, resulting
          // in some perf boost.
          this.$off('updated', this.data.updated);
          this.data.notifyNestedSubs()
        },

        isSubscribed() {
          return Boolean(this.data.subscription) && this.data.subscription.isSubscribed()
        },
        getProps(props) {
          const withExtras = this.addExtraProps(props);
          return {
            ...withExtras,
            props: Object.keys(componentProps).reduce(
              (acc, key) => {
                acc[key] = withExtras.props[key];
                return acc;
              },
              {},
            )
          };
        },
        addExtraProps(props) {
          if (!withRef && !renderCountProp && !(this.data.propsMode && this.data.subscription)) {
            return { props }
          }
          // make a shallow copy so that fields added don't leak to the original selector.
          // this is especially important for 'ref' since that's a reference back to the component
          // instance. a singleton memoized selector would then be holding a reference to the
          // instance, preventing the instance from being garbage collected, and that would be bad
          const withExtras = { props: { ...props } }
          if (withRef) withExtras.ref = refKey;
          if (renderCountProp) withExtras.props[renderCountProp] = this.data.renderCount++
          if (this.data.propsMode && this.data.subscription) {
            withExtras.props[subscriptionKey] = this.data.subscription
          }
          return withExtras
        },
      },
      created() {
        this.data.updated = () => {
          this.data.selector.run(this.$props)
        }
        this.$on('updated', this.data.updated);
        invariant(this.data.store,
          `Could not find "${storeKey}" in either the context or props of ` +
          `"${displayName}". Either wrap the root component in a <Provider>, ` +
          `or explicitly pass "${storeKey}" as a prop to "${displayName}".`
        )
      },
      mounted() {
        if (!shouldHandleStateChanges) return

        // created fires during server side rendering, but mounted and
        // beforeDestroy do not. Because of this, trySubscribe happens during mounted.
        // Otherwise, unsubscription would never take place during SSR, causing a memory leak.
        // To handle the case where a child component may have triggered a state change by
        // dispatching an action in its created, we have to re-run the select and maybe
        // re-render.
        this.data.subscription.trySubscribe()
        this.data.selector.run(this.$props)
        if (this.data.selector.shouldComponentUpdate) this.$forceUpdate()
      },
      beforeDestroy() {
        if (this.data.subscription) this.data.subscription.tryUnsubscribe()
        this.data.subscription = null
        this.data.notifyNestedSubs = noop
        this.data.store = null
        this.data.selector.run = noop
        this.data.selector.shouldComponentUpdate = false
      },
      render(h) {
        const selector = this.data.selector
        selector.shouldComponentUpdate = false
        if (selector.error) {
          throw selector.error
        } else {
          return h(
            WrappedComponent,
            this.getProps(selector.props),
            this.$slots.default
          )
        }
      },
    }

    Connect.WrappedComponent = WrappedComponent
    Connect.name = displayName

    if (process.env.NODE_ENV !== 'production') {
      Connect.beforeUpdate = function beforeUpdate() {
        // We are hot reloading!
        if (this.data.version !== version) {
          this.data.version = version
          this.initSelector()

          // If any connected descendants don't hot reload (and resubscribe in the process), their
          // listeners will be lost when we unsubscribe. Unfortunately, by copying over all
          // listeners, this does mean that the old versions of connected descendants will still be
          // notified of state changes; however, their onStateChange function is a no-op so this
          // isn't a huge deal.
          let oldListeners = [];

          if (this.data.subscription) {
            oldListeners = this.data.subscription.listeners.get()
            this.data.subscription.tryUnsubscribe()
          }
          this.initSubscription()
          if (shouldHandleStateChanges) {
            this.data.subscription.trySubscribe()
            oldListeners.forEach(listener => this.data.subscription.listeners.subscribe(listener))
          }
        }
      }
    }
    return Connect
    // TODO: return hoistStatics(Connect, WrappedComponent)
  }
}
