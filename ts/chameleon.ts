enum ChameleonState {
    Idle, Draw, Pan, Rotate
}

/**
 * The camera manipulation is borrowed from THREE.TrackballControls from the three.js examples
 */
class Chameleon {
    private static _showCanvasInNewWindow(canvas: HTMLCanvasElement) {
        var dataURL = canvas.toDataURL("image/png");
        var newWindow = window.open();
        newWindow.document.write('<img style="border:1px solid black" src="' + dataURL + '"/>');
    }

    private static CAMERA_NEAR = 0.5;

    private _state: ChameleonState = ChameleonState.Idle;

    private _geometry: THREE.Geometry;
    private _mesh: THREE.Mesh = new THREE.Mesh();
    canvas: HTMLCanvasElement;
    private _headLight: THREE.PointLight = new THREE.PointLight(0xFFFFFF, 0.4);
    private _camera: THREE.PerspectiveCamera = (() => {
        var camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, Chameleon.CAMERA_NEAR, 10000);
        camera.position.z = 5;
        return camera;
    })();
    private _scene: THREE.Scene = (() => {
        var scene = new THREE.Scene();

        var ambientLight = new THREE.AmbientLight(0x777777);
        scene.add(ambientLight);

        var light = new THREE.DirectionalLight(0xFFFFFF, 0.2);
        light.position.set(320, 390, 700);
        scene.add(light);

        var light2 = new THREE.DirectionalLight(0xFFFFFF, 0.2);
        light2.position.set(-720, -190, -300);
        scene.add(light2);

        scene.add(this._headLight);

        scene.add(this._mesh);

        return scene;
    })();

    private _renderer: THREE.Renderer = (() => {
        var renderer = new THREE.WebGLRenderer({antialias: true});
        renderer.setClearColor(0xAAAAAA, 1.0);
        return renderer;
    })();

    rotateSpeed: number = 1.5;
    zoomSpeed: number = 1.2;
    panSpeed: number = 0.8;

    canvasBox = {left: 0, top: 0, width: 0, height: 0};
    target: THREE.Vector3 = new THREE.Vector3();

    private _eye: THREE.Vector3 = new THREE.Vector3();
    private _rotateStart: THREE.Vector3 = new THREE.Vector3();
    private _rotateEnd: THREE.Vector3 = new THREE.Vector3();
    private _zoomStart: number = 0;
    private _zoomEnd: number = 0;
    private _panStart: THREE.Vector2 = new THREE.Vector2();
    private _panEnd: THREE.Vector2 = new THREE.Vector2();

    private _viewingTextureUvs: THREE.Vector2[][];
    private _viewingMaterial: THREE.MeshFaceMaterial;
    private _drawingTextureUvs: THREE.Vector2[][];
    private _drawingCanvas: HTMLCanvasElement = document.createElement('canvas');
    private _drawingCanvasContext: CanvasRenderingContext2D = this._drawingCanvas.getContext('2d');
    private _drawingMaterial: THREE.MeshLambertMaterial =
        new THREE.MeshLambertMaterial({
            map: new THREE.Texture(this._drawingCanvas)
        });
    private _usingViewingTexture: boolean;

    private _drawingTextureMesh: THREE.Mesh = new THREE.Mesh();
    private _drawingTextureScene: THREE.Scene = (() => {
        var scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xFFFFFF));
        scene.add(this._drawingTextureMesh);
        return scene;
    })();

    private _drawingVertexUvs: THREE.Vector3[];
    private _nAffectedFaces: number = 0;
    private _affectedFaces: Uint32Array;
    private _isFaceAffected: Uint8Array; // Used as if it's a boolean array
    private _affectedFacesEmpty: Uint8Array; // Used to clear _isFaceAffected. Should not be modified once initialized.

    handleResize() {
        this._renderer.setSize(this.canvas.width, this.canvas.height);
        this._camera.aspect = this.canvas.width / this.canvas.height;
        this._camera.updateProjectionMatrix();

        var canvasRect = this.canvas.getBoundingClientRect();
        var docElement = this.canvas.ownerDocument.documentElement;
        this.canvasBox.left = canvasRect.left + window.pageXOffset - docElement.clientLeft;
        this.canvasBox.top = canvasRect.top + window.pageYOffset - docElement.clientTop;
        this.canvasBox.width = canvasRect.width;
        this.canvasBox.height = canvasRect.height;

        this._useViewingTexture();
    }

    private _getMousePositionInCanvas = (() => {
        var vector = new THREE.Vector2();
        return (event: MouseEvent, normalize: boolean = false) => {
            vector.set(
                event.pageX - this.canvasBox.left,
                event.pageY - this.canvasBox.top
            );
            if (normalize) {
                vector.x /= this.canvas.width;
                vector.y /= this.canvas.height;
            }
            return vector;
        };
    })();

    private _getMouseProjectionOnBall = (() => {
        var vector = new THREE.Vector3();
        var objectUp = new THREE.Vector3();
        var mouseOnBall = new THREE.Vector3();

        return (event: MouseEvent) => {
            mouseOnBall.set(
                ( event.pageX - this.canvasBox.width * 0.5 - this.canvasBox.left ) / (this.canvasBox.width * .5),
                ( this.canvasBox.height * 0.5 + this.canvasBox.top - event.pageY ) / (this.canvasBox.height * .5),
                0.0
            );
            var length = mouseOnBall.length();

            if (length > 1.0) {
                mouseOnBall.normalize();
            } else {
                mouseOnBall.z = Math.sqrt(1.0 - length * length);
            }

            this._eye.subVectors(this._camera.position, this.target);

            vector.copy(this._camera.up).setLength(mouseOnBall.y);
            vector.add(objectUp.copy(this._camera.up).cross(this._eye).setLength(mouseOnBall.x));
            vector.add(this._eye.setLength(mouseOnBall.z));

            return vector;
        };
    })();

    rotateCamera = (()=> {
        var axis = new THREE.Vector3(),
            quaternion = new THREE.Quaternion();

        return () => {
            var angle = Math.acos(
                this._rotateStart.dot(this._rotateEnd) / this._rotateStart.length() / this._rotateEnd.length()
            );
            if (angle) {
                axis.crossVectors(this._rotateStart, this._rotateEnd).normalize();
                angle *= this.rotateSpeed;
                quaternion.setFromAxisAngle(axis, -angle);

                this._eye.applyQuaternion(quaternion);
                this._camera.up.applyQuaternion(quaternion);

                this._rotateEnd.applyQuaternion(quaternion);
                this._rotateStart.copy(this._rotateEnd);
            }
        }
    })();

    zoomCamera() {
        var factor = 1.0 + ( this._zoomEnd - this._zoomStart ) * this.zoomSpeed;
        if (factor !== 1.0 && factor > 0.0) {
            this._eye.multiplyScalar(factor);
            this._zoomStart = this._zoomEnd;
        }
    }

    panCamera = (() => {
        var mouseChange = new THREE.Vector2(),
            objectUp = new THREE.Vector3(),
            pan = new THREE.Vector3();

        return () => {
            mouseChange.subVectors(this._panEnd, this._panStart);
            if (mouseChange.lengthSq()) {
                mouseChange.multiplyScalar(this._eye.length() * this.panSpeed);
                pan.crossVectors(this._eye, this._camera.up).setLength(mouseChange.x).add(
                    objectUp.copy(this._camera.up).setLength(mouseChange.y)
                );
                this._camera.position.add(pan);
                this.target.add(pan);
                this._panStart.copy(this._panEnd);
            }
        }
    })();

    update() {
        this._eye.subVectors(this._camera.position, this.target);

        this.rotateCamera();
        this.zoomCamera();
        this.panCamera();

        this._camera.position.addVectors(this.target, this._eye);
        this._camera.lookAt(this.target);

        this._headLight.position.copy(this._camera.position);

        this._renderer.render(this._scene, this._camera);
        this.canvas.getContext('2d').drawImage(this._renderer.domElement, 0, 0);
    }

    private _useViewingTexture() {
        // If already using the viewing texture, do nothing
        if (this._usingViewingTexture) {
            return;
        }

        var xMax = this._drawingTextureUvs[this._affectedFaces[0]][0].x;
        var xMin = xMax;
        var yMax = Math.abs(this._drawingTextureUvs[this._affectedFaces[0]][0].y - 1);
        var yMin = yMax;
        for (var i = 0; i < this._nAffectedFaces; i += 1) {
            xMax = Math.max(xMax,
                this._drawingTextureUvs[this._affectedFaces[i]][0].x,
                this._drawingTextureUvs[this._affectedFaces[i]][1].x,
                this._drawingTextureUvs[this._affectedFaces[i]][2].x);

            yMax = Math.max(yMax,
                Math.abs(this._drawingTextureUvs[this._affectedFaces[i]][0].y - 1),
                Math.abs(this._drawingTextureUvs[this._affectedFaces[i]][1].y - 1),
                Math.abs(this._drawingTextureUvs[this._affectedFaces[i]][2].y - 1));

            xMin = Math.min(xMin,
                this._drawingTextureUvs[this._affectedFaces[i]][0].x,
                this._drawingTextureUvs[this._affectedFaces[i]][1].x,
                this._drawingTextureUvs[this._affectedFaces[i]][2].x);

            yMin = Math.min(yMin,
                Math.abs(this._drawingTextureUvs[this._affectedFaces[i]][0].y - 1),
                Math.abs(this._drawingTextureUvs[this._affectedFaces[i]][1].y - 1),
                Math.abs(this._drawingTextureUvs[this._affectedFaces[i]][2].y - 1));
        }
        var txmax = xMax * this._drawingCanvas.width;
        var txmin = xMin * this._drawingCanvas.width;
        var tymax = yMax * this._drawingCanvas.height;
        var tymin = yMin * this._drawingCanvas.height;

        this._drawingCanvasContext.rect(
            xMin * this._drawingCanvas.width, yMin * this._drawingCanvas.height,
            xMax * this._drawingCanvas.width, yMax * this._drawingCanvas.height);
        this._drawingCanvasContext.clip();
        var localCanvas = document.createElement('canvas');
        localCanvas.width = txmax - txmin;
        localCanvas.height = tymax - tymin;
        localCanvas.getContext('2d').drawImage(
            this._drawingCanvas,
            txmin, tymin, txmax - txmin, tymax - tymin,
            0, 0, txmax - txmin, tymax - tymin
        );

        for (var i = 0; i < this._nAffectedFaces; i++) {
            var faceIndex = this._affectedFaces[i];
            var faceMaterial = <THREE.MeshLambertMaterial>this._viewingMaterial.materials[faceIndex];
            faceMaterial.map.image = localCanvas;
            faceMaterial.map.needsUpdate = true;
            for (var j = 0; j < 3; j += 1) {
                var drawingUV = this._drawingTextureUvs[faceIndex][j];
                this._viewingTextureUvs[faceIndex][j].setX(
                    (drawingUV.x - xMin) * (this._drawingCanvas.width) / (txmax - txmin)
                ).setY(
                    (drawingUV.y - 1 + yMax) * (this._drawingCanvas.height) / (tymax - tymin)
                );
            }
        }

        this._nAffectedFaces = 0;
        this._isFaceAffected.set(this._affectedFacesEmpty);

        this._mesh.material = this._viewingMaterial;
        this._geometry.faceVertexUvs[0] = this._viewingTextureUvs;
        this._geometry.uvsNeedUpdate = true;
        this._usingViewingTexture = true;
    }

    private _useDrawingTexture() {
        // If already using the drawing texture, do nothing
        if (!this._usingViewingTexture) {
            return;
        }

        this._renderer.render(this._drawingTextureScene, this._camera);
        this._drawingCanvas.width = this._renderer.domElement.width;
        this._drawingCanvas.height = this._renderer.domElement.height;
        this._drawingCanvasContext.drawImage(this._renderer.domElement, 0, 0);
        this._drawingMaterial.map.needsUpdate = true;

        for (var i = 0; i < this._geometry.vertices.length; i += 1) {
            this._drawingVertexUvs[i].copy(this._geometry.vertices[i]).project(this._camera);

            this._drawingVertexUvs[i].x = (this._drawingVertexUvs[i].x + 1) / 2;
            this._drawingVertexUvs[i].y = (this._drawingVertexUvs[i].y + 1) / 2;
        }
        for (var i = 0; i < this._geometry.faces.length; i += 1) {
            this._drawingTextureUvs[i][0].copy(<any>this._drawingVertexUvs[this._geometry.faces[i].a]);
            this._drawingTextureUvs[i][1].copy(<any>this._drawingVertexUvs[this._geometry.faces[i].b]);
            this._drawingTextureUvs[i][2].copy(<any>this._drawingVertexUvs[this._geometry.faces[i].c]);
        }

        this._mesh.material = this._drawingMaterial;
        this._geometry.faceVertexUvs[0] = this._drawingTextureUvs;
        this._geometry.uvsNeedUpdate = true;
        this._usingViewingTexture = false;
    }

    private _castRayFromMouse(event: MouseEvent): THREE.Intersection[] {
        var canvasPos = this._getMousePositionInCanvas(event, true);
        var mouse3d = new THREE.Vector3(
            canvasPos.x * 2 - 1,
            -canvasPos.y * 2 + 1,
            Chameleon.CAMERA_NEAR
        ).unproject(this._camera).sub(this._camera.position).normalize();

        return new THREE.Raycaster(
            this._camera.position,
            mouse3d,
            Chameleon.CAMERA_NEAR
        ).intersectObject(this._mesh);
    }

    private _computeMousePositionInDrawingCanvas = (() => {
        var barycoord = new THREE.Vector3();
        var baryCoordXYZ = new Float32Array(3);
        var uv = new THREE.Vector2();

        return (event: MouseEvent) => {
            var intersections = this._castRayFromMouse(event);
            if (intersections.length == 0) {
                return {pos: this._getMousePositionInCanvas(event), face: -1};
            }

            var face = intersections[0].face;
            var faceIndex = <number>(<any>face).index;

            THREE.Triangle.barycoordFromPoint(
                intersections[0].point,
                this._geometry.vertices[face.a],
                this._geometry.vertices[face.b],
                this._geometry.vertices[face.c],
                barycoord
            );
            barycoord.toArray(<any>baryCoordXYZ);

            var drawingCanvasPos = new THREE.Vector2();
            for (var i = 0; i < 3; i += 1) {
                uv.copy(
                    this._drawingTextureUvs[faceIndex][i]
                ).multiplyScalar(baryCoordXYZ[i]);
                drawingCanvasPos.add(uv);
            }
            drawingCanvasPos.x *= this._drawingCanvas.width;
            drawingCanvasPos.y = (1 - drawingCanvasPos.y) * this._drawingCanvas.height; // why 1-??
            drawingCanvasPos.round();

            return {pos: drawingCanvasPos, face: faceIndex};
        }
    })();

    private _recordAffectedFace(faceIndex: number) {
        if (faceIndex >= 0 && !this._isFaceAffected[faceIndex]) {
            this._affectedFaces[this._nAffectedFaces] = faceIndex;
            this._isFaceAffected[faceIndex] = 1;
            this._nAffectedFaces += 1;
        }
    }

    private _mousedown = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        if (this._state !== ChameleonState.Idle) {
            return;
        }

        // Hold shift key to rotate and pan
        if (event.shiftKey) {
            this._useViewingTexture();

            switch (event.button) {
                case 0: // Left button
                    this._state = ChameleonState.Rotate;
                    this._rotateStart.copy(this._getMouseProjectionOnBall(event));
                    this._rotateEnd.copy(this._rotateStart);
                    break;
                case 2: // Right button
                    this._state = ChameleonState.Pan;
                    this._panStart.copy(this._getMousePositionInCanvas(event, true));
                    this._panEnd.copy(this._panStart);
                    break;
                default:
                    console.log(event);
            }
        } else {
            this._state = ChameleonState.Draw;
            this._useDrawingTexture();

            var pos_face = this._computeMousePositionInDrawingCanvas(event);
            this._drawingCanvasContext.moveTo(pos_face.pos.x, pos_face.pos.y);
            this._drawingCanvasContext.strokeStyle = '#ff0000';
            this._drawingCanvasContext.stroke();
            this._drawingMaterial.map.needsUpdate = true;

            this._recordAffectedFace(pos_face.face);
        }

        document.addEventListener('mousemove', this._mousemove, false);
        document.addEventListener('mouseup', this._mouseup, false);
    };

    private _mousemove = (event: MouseEvent) => {
        if (this._state === ChameleonState.Idle) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        switch (this._state) {
            case ChameleonState.Rotate:
                this._rotateEnd.copy(this._getMouseProjectionOnBall(event));
                break;
            case ChameleonState.Pan:
                this._panEnd.copy(this._getMousePositionInCanvas(event, true));
                break;
            case ChameleonState.Draw:
                var pos_face = this._computeMousePositionInDrawingCanvas(event);
                this._drawingCanvasContext.lineTo(pos_face.pos.x, pos_face.pos.y);
                this._drawingCanvasContext.stroke();
                this._drawingMaterial.map.needsUpdate = true;

                this._recordAffectedFace(pos_face.face);
                break;
            default:
                debugger;
        }
    };

    private _mouseup = (event: MouseEvent) => {

        event.preventDefault();
        event.stopPropagation();

        this.update();
        this._state = ChameleonState.Idle;

        document.removeEventListener('mousemove', this._mousemove);
        document.removeEventListener('mouseup', this._mouseup);
    };

    private _mousewheel = (event: MouseWheelEvent) => {
        event.preventDefault();
        event.stopPropagation();

        if (this._state !== ChameleonState.Idle || !event.shiftKey) {
            return;
        }

        this._useViewingTexture();

        var delta = 0;

        if (event.wheelDelta) { // WebKit / Opera / Explorer 9
            delta = event.wheelDelta / 40;
        } else if (event.detail) { // Firefox
            delta = -event.detail / 3;
        }
        this._zoomStart += delta * 0.01;
    };

    constructor(geometry: THREE.Geometry, canvas?: HTMLCanvasElement) {
        this._geometry = geometry.clone();
        for (var i = 0; i < this._geometry.faces.length; i += 1) {
            var face: any = this._geometry.faces[i];
            face.index = i;
        }

        if (!canvas) {
            canvas = document.createElement('canvas');
        }
        this.canvas = canvas;
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault(), false);
        this.canvas.addEventListener('mousedown', this._mousedown, false);
        this.canvas.addEventListener('mousewheel', this._mousewheel, false);
        this.canvas.addEventListener('DOMMouseScroll', this._mousewheel, false); // firefox

        this._drawingVertexUvs = [];
        for (var i = 0; i < this._geometry.vertices.length; i += 1) {
            this._drawingVertexUvs.push(new THREE.Vector3());
        }
        this._nAffectedFaces = 0;
        this._affectedFaces = new Uint32Array(this._geometry.faces.length);
        this._isFaceAffected = new Uint8Array(this._geometry.faces.length);
        this._affectedFacesEmpty = new Uint8Array(this._geometry.faces.length);

        var initializeViewingTexture = () => {
            var singlePixelCanvas = <HTMLCanvasElement>document.createElement('canvas');
            singlePixelCanvas.width = singlePixelCanvas.height = 1;
            var context = singlePixelCanvas.getContext('2d');
            context.fillStyle = '#FFFFFF';
            context.fillRect(0, 0, 1, 1);

            this._viewingTextureUvs = [];
            var faces = this._geometry.faces;
            this._viewingMaterial = new THREE.MeshFaceMaterial();
            for (var i = 0; i < faces.length; i += 1) {
                faces[i].materialIndex = i;
                this._viewingTextureUvs.push([
                    new THREE.Vector2(0.5, 0.5),
                    new THREE.Vector2(0.5, 0.5),
                    new THREE.Vector2(0.5, 0.5)
                ]);

                var lambertMaterial = new THREE.MeshLambertMaterial({map: new THREE.Texture(singlePixelCanvas)});
                lambertMaterial.map.needsUpdate = true;
                this._viewingMaterial.materials.push(lambertMaterial);
            }
        };
        initializeViewingTexture();

        var initializeDrawingTexture = () => {
            this._drawingTextureUvs = [];
            var faces = this._geometry.faces;
            for (var i = 0; i < faces.length; i += 1) {
                this._drawingTextureUvs.push([
                    new THREE.Vector2(0.5, 0.5),
                    new THREE.Vector2(0.5, 0.5),
                    new THREE.Vector2(0.5, 0.5)
                ]);
            }
        };
        initializeDrawingTexture();

        this._mesh.geometry = this._geometry;
        this._mesh.material = this._viewingMaterial;
        this._geometry.faceVertexUvs[0] = this._viewingTextureUvs;
        this._geometry.uvsNeedUpdate = true;
        this._usingViewingTexture = true;

        this._drawingTextureMesh.geometry = this._geometry;
        this._drawingTextureMesh.material = this._viewingMaterial;

        this.handleResize();
        this.update();
    }

}