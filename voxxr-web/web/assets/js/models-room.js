(function(exports) {
    var DISCONNECTED = "disconnected";
    var CONNECTED = "connected";
    var CONNECTING = "connecting";

    var Room = function(data) {
        var self = this;
        self.id = ko.observable();
        self.uri = ko.observable();
        self.name = ko.observable();
        self.rt = ko.observable();
        self.presentation = ko.observable();
        self.data = ko.observable({});

        self.connections = ko.observable(0);
        self.status = ko.observable(DISCONNECTED);
        self.message = ko.observable(null);
        self.connected = ko.computed(function() {
            return self.status() === CONNECTED;
        });
        self.connecting = ko.computed(function() {
            return self.status() === CONNECTING;
        });

        // enter and quit are automatically called when changing current
        self.enter = function() {
            self.connect();
        }
        self.quit = function() {
            self.disconnect();
        };

        // API
        self.join = function() {
            Room.current(self);
        };
        self.leave = function() {
            Room.current(null);
            window.history.back();
        };

        var reconnectAttemptsDelay = 250;
        var reconnectAttemptTimeout = null;
        function attemptToReconnect() {
            if (!Room.current().id()) {
                return;
            }
            reconnectAttemptsDelay *= 2;
            console.log('attempt to reconnect in ' + reconnectAttemptsDelay + 'ms');
            reconnectAttemptTimeout = setTimeout(function() {self.connect();}, reconnectAttemptsDelay);
        }

        self.connect = function() {
            if (self.status() === DISCONNECTED) {
                if (reconnectAttemptTimeout) {
                    clearTimeout(reconnectAttemptTimeout);
                    reconnectAttemptTimeout = null;
                }
                console.log('joining room');
                self.message("Connecting to room...");
                self.status(CONNECTING);
                $.ajax({
                    type: "GET",
                    url: self.rt() + "/r/room",
                    dataType:"json",
                    success: function(resp) {
                        if (resp.status === 'ok') {
                            reconnectAttemptsDelay = 250; // reset reconnect attempt delay
                            self.connections(resp.connections);
                            var p;
                            if (resp.pres) {
                                p = ds.presentation({id: resp.pres, title: resp.title});
                                p.rate.nb(resp.ratings);
                                p.rate.avg(resp.rate * 100);
                                p.load();
                            } else {
                                p = null;
                            }
                            models.Presentation.current(p);
                            self.message(null);
                            self.status(CONNECTED);
                            console.log('ROOM CONNECTED');
                            self.message("Connected...");
                            setTimeout(function() {
                                self.message("");
                            }, 3000);
                            subscribe(self);
                        } else {
                            self.message(resp.message);
                            self.status(DISCONNECTED);
                            attemptToReconnect();
                        }
                    },
                    error: function(xhr, type) {
                        console.log('-------------- CONNECTION ERROR', xhr);
                        self.message("Can't connect to room. Is it currently opened?");
                        self.status(DISCONNECTED);
                        attemptToReconnect();
                    }
                });
            }
        };


        self.reconnect = function() {
            self.disconnect();
            self.connect();
        };

        self.disconnect = function() {
            reconnectAttemptsDelay = 250; // reset
            if (reconnectAttemptTimeout) {
                clearTimeout(reconnectAttemptTimeout);
                reconnectAttemptTimeout = null;
            }
            if (self.status() !== DISCONNECTED) {
                console.log("<<< disconnecting from ", self.name());
                $.atmosphere.closeSuspendedConnection();
            }
            self.message(null);
            self.status(DISCONNECTED);
        };

        var transport = "long-polling";
        if ('WebSocket' in window) {
            transport = "websocket";
        }

        function subscribe(room) {
            var $room = room;
            console.log('>>> SUBSCRIBING TO ', $room.rt(), '/r/room/rt', ' with transport ', transport);
            $.atmosphere.subscribe(
                $room.rt() + '/r/room/rt?mode=' + Room.bcmode,
                function(response) {
                    if (!Room.current().id()) {
                        // no current room, it seems that we didn't properly quit
                        $room.status(CONNECTED); // set status to connected to make sure disconnect actually call suspend connection
                        $room.disconnect();
                        return;
                    }

                    if (response.state == 'error' || response.state == 'closed') {
                        $room.message("Room connection lost");
                        $room.status(DISCONNECTED);
                        attemptToReconnect();
                        return;
                    }

                    if (response.transport != 'polling'
                        && response.state != 'connected' && response.state != 'closed') {
                        if (response.status == 200) {
                            var data = response.responseBody;
                            if (data.length > 0) {
                                var ev = exports.models.EV.fromBC(data, $room.id());

                                if (ev.isConnection) {
                                    $room.connections(ev.connections);
                                }
                                var pres = models.Presentation.current();
                                if (ev.isTitle) {
                                    pres.title(ev.title);
                                }
                                if (ev.isPollStart) {
                                    pres.currentPoll.choices(
                                        _(ev.items).map(function(e,i) { return {title: e, index: i}; })
                                    );
                                }
                                if (ev.isPollEnd) {
                                    pres.currentPoll.choices([]);
                                }
                                if (ev.isRate) {
                                    var rate = pres.rate;
                                    rate.avg(((rate.avg() * rate.nb()) + (ev.rateValue * 100)) / (rate.nb() + 1));
                                    rate.nb(rate.nb() + 1);
                                }
                                if (ev.isHotFactor) {
                                    pres.hotFactor(ev.hotFactorValue);
                                }
                                if (ev.isPrezStart) {
                                    pres.start();
                                }
                                if (ev.isPrezEnd) {
                                    pres.stop();
                                }

                                $("body").trigger('EV', ev);
                            }
                        }
                    }
                },
                $.atmosphere.request = { transport: transport, maxRequest : 100000 });
        }

        self.sendEV = function(ev, onsuccess, onerror) {
            if (!self.rt()) {
                console.log('-------------- EV ERROR: cannot send EV when not connected');
                onerror();
                return;
            }
            console.log('sending EV ', ev, ' ON ', self.rt(), "/r/feedback");
            $.ajax({
                type: "POST",
                url: self.rt() + "/r/feedback",
                data: models.EV.toBC(models.User.current().name(), ev),
                dataType:"json",
                success: function( resp ) {
                    if (resp.status === 'ok') {
                        console.log('-------------- EV SUCCESS ', ev);
                        if (onsuccess) onsuccess(resp);
                    }
                },
                error: function(xhr, type) {
                    console.log('-------------- EV ERROR' + xhr);
                    if (onerror) onerror();
                }
            });
        }

        function loadData(data) {
            data = mergeData(data, self);
            self.id(data.id);
            self.uri(data.uri);
            self.name(data.name);
            self.rt(data.rt);
            if (!data.id) {
                self.connections(0);
                self.status(DISCONNECTED);
                self.message(null);
            }
        }
        self.load = function(data) {
            if (data) {
                loadData(data);
            } else {
                getJSON(self.uri(), loadData);
            }
        }
        
        loadData(data);
    };
    Room.DISCONNECTED = DISCONNECTED;
    Room.CONNECTED = CONNECTED;
    Room.CONNECTING = CONNECTING;

    Room.current = currentModelObject(new Room({}),
        ['message', 'status', 'connections']);

    Room.bcmode = "USER";
    Room.onEV = function(callback) {
        $("body").bind('EV', function(event, ev) {
            callback(event.data || ev);
        });
    };

    exports.models = exports.models || {};
    exports.models.Room = Room;
})(window);